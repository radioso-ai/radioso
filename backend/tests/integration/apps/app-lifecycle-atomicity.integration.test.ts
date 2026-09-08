import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

import {
  AppConnectionService,
  AppExecutionEligibilityService,
  AppInstallationLifecycleService,
  AppInstallationPlanService,
  AppReleaseAdmissionService,
  AppAuditOutboxDispatcher,
  type AppContributionStagingPort,
  type AppOperatorAuthorizationPort,
  type AppRuntimeProvisioningPort,
} from "../../../src/modules/apps/public.js";
import { createAppRepositories, createAppsUnitOfWork } from "../../../src/app/composition/apps.js";
import { Database } from "../../../src/shared/infra/database.js";
import { createLogger } from "../../../src/shared/observability/logger.js";
import { resolveIntegrationDatabase } from "../support/integrationDatabase.js";

/**
 * The Apps saga's atomicity claims, made against a real transaction.
 *
 * The in-memory unit of work runs work against one shared object graph and has no
 * rollback, so it cannot answer "does a lost compare-and-set leave nothing behind" — the
 * question this file exists for. Everything here is a race the control plane says it
 * survives: a step whose ownership moved mid-commit, two retries of one request, a
 * revocation landing beside a consume or an activation, and an installation that has to be
 * executable again after it is re-enabled.
 */

const manifestPath = fileURLToPath(
  new URL("../../../../packages/app-contract/fixtures/reference/wordpress.manifest.json", import.meta.url),
);
const manifestDocument = () => JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
const artifactDigests = () => {
  const document = manifestDocument() as {
    artifact: { digest: string };
    companionAssets?: Array<{ digest: string }>;
  };
  return [document.artifact.digest, ...(document.companionAssets ?? []).map((asset) => asset.digest)];
};

/** The version the reference manifest's compatibility range admits. */
const RUNNING_RADIOSO_VERSION = "0.1.0";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("Apps lifecycle atomicity (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const repositories = createAppRepositories(database.kysely);
  const unitOfWork = createAppsUnitOfWork(database.kysely);
  const logger = createLogger("error", { write: () => {} });
  const audit = { record: vi.fn(async () => {}) };
  const auditDelivery = new AppAuditOutboxDispatcher({ outbox: repositories.auditOutbox, audit, logger });

  const authorization: AppOperatorAuthorizationPort = {
    authorizeAppAdministration: async () => ({ ok: true }),
  };
  const provisioning = {
    provision: vi.fn(async () => ({ ok: true as const })),
    deprovision: vi.fn(async () => ({ ok: true as const })),
  } satisfies AppRuntimeProvisioningPort;
  const staging = {
    stage: vi.fn(async () => ({ ok: true as const })),
    runSafeTests: vi.fn(async () => ({ ok: true as const })),
    detach: vi.fn(async () => ({ ok: true as const })),
    promote: vi.fn(async () => ({ ok: true as const })),
    discardCandidate: vi.fn(async () => ({ ok: true as const })),
  } satisfies AppContributionStagingPort;

  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const principal = { accountId, userId: randomUUID() };

  const releaseAdmission = new AppReleaseAdmissionService({
    releases: repositories.releases,
    unitOfWork,
    builtInReleases: [{ manifest: manifestDocument(), artifactDigests: artifactDigests() }],
    auditDelivery,
    logger,
    runningRadiosoVersion: RUNNING_RADIOSO_VERSION,
  });
  const plans = new AppInstallationPlanService({
    releases: repositories.releases,
    installations: repositories.installations,
    connections: repositories.connections,
    plans: repositories.plans,
    unitOfWork,
    authorization,
    auditDelivery,
    runningRadiosoVersion: RUNNING_RADIOSO_VERSION,
  });
  const lifecycle = new AppInstallationLifecycleService({
    installations: repositories.installations,
    plans: repositories.plans,
    releases: repositories.releases,
    connections: repositories.connections,
    operations: repositories.operations,
    unitOfWork,
    runtimeProvisioning: provisioning,
    contributionStaging: staging,
    dataDisposition: { dispose: async () => ({ ok: true }) },
    authorization,
    auditDelivery,
    logger,
    runningRadiosoVersion: RUNNING_RADIOSO_VERSION,
  });
  const connections = new AppConnectionService({
    installations: repositories.installations,
    releases: repositories.releases,
    connections: repositories.connections,
    operations: repositories.operations,
    unitOfWork,
    cipher: { keyId: "test", encrypt: (plaintext) => `enc(${plaintext})` },
    authorization,
    auditDelivery,
    runningRadiosoVersion: RUNNING_RADIOSO_VERSION,
  });
  const eligibility = new AppExecutionEligibilityService({
    unitOfWork,
    runningRadiosoVersion: RUNNING_RADIOSO_VERSION,
  });

  let releaseId = "";

  beforeAll(async () => {
    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [accountId, "Apps Atomicity Co", `acct-${accountId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [workspaceId, accountId, "Apps Atomicity Workspace", `route-${workspaceId}`],
    );
    await releaseAdmission.syncBuiltInReleases();
    releaseId = (await repositories.releases.listInstallable())[0].id;
  });

  afterAll(async () => {
    await database.query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  beforeEach(async () => {
    await database.query(`DELETE FROM app_lifecycle_operations WHERE workspace_id = $1`, [workspaceId]);
    await database.query(`DELETE FROM app_installations WHERE workspace_id = $1`, [workspaceId]);
    await database.query(`DELETE FROM app_installation_plans WHERE workspace_id = $1`, [workspaceId]);
    await database.query(`UPDATE app_releases SET state = 'admitted' WHERE id = $1`, [releaseId]);
    provisioning.provision.mockClear();
    provisioning.deprovision.mockClear();
    staging.stage.mockClear();
  });

  const plan = async () => plans.create({
    workspaceId,
    releaseId,
    configuration: { site_url: "https://example.com" },
    principal,
  });

  const apply = async (idempotencyKey: string) => {
    const created = await plan();
    return lifecycle.apply({
      workspaceId,
      planId: created.id,
      checksum: created.checksum,
      expectedInstallationVersion: null,
      idempotencyKey,
      principal,
    });
  };

  const readyToActivate = async (key: string) => {
    const applied = await apply(key);
    await connections.bind({
      workspaceId,
      installationId: applied.installation.id,
      slotId: "webhook_secret",
      values: {},
      expectedVersion: applied.installation.version,
      idempotencyKey: `${key}-bind`,
      principal,
    });
    const current = await repositories.installations.findById(workspaceId, applied.installation.id);
    return { installationId: applied.installation.id, version: current!.version };
  };

  const stateOf = async (installationId: string) =>
    (await repositories.installations.findById(workspaceId, installationId))!;

  const countOf = async (table: string, predicate = "TRUE"): Promise<number> => {
    const rows = await database.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM ${table} WHERE workspace_id = $1 AND ${predicate}`,
      [workspaceId],
    );
    return rows[0].count;
  };

  it("rolls a step back whole when the cursor compare-and-set finds this driver no longer owns it", async () => {
    const { installationId, version } = await readyToActivate("cas-rollback");

    // The provider answers, but by the time it does another driver has taken the
    // operation over. The step's database effects are already written in the open
    // transaction; the lost cursor has to take them with it.
    provisioning.provision.mockImplementationOnce(async () => {
      const operation = (await repositories.operations.findActiveByInstallation(installationId))!;
      await database.query(
        `UPDATE app_lifecycle_operations SET lease_owner = $1, lease_expires_at = NOW() + interval '5 minutes' WHERE id = $2`,
        [randomUUID(), operation.id],
      );
      return { ok: true as const };
    });

    const outcome = await lifecycle.activate({
      workspaceId,
      installationId,
      expectedVersion: version,
      idempotencyKey: "cas-rollback-activate",
      principal,
    });

    // Nothing of the step survives: not the state it entered, not the cursor, not the
    // version bump, and not an audit record saying it happened.
    const installation = await stateOf(installationId);
    expect(installation.state).toBe("planned");
    // Only the claim's own version bump, which committed before the step ran.
    expect(installation.version).toBe(version + 1);
    expect(outcome.operation.step).toBeNull();
    expect(await countOf("app_audit_outbox", `event->>'eventType' = 'app.installation.activated'`)).toBe(0);
  });

  it("answers two concurrent retries of one apply with the same operation and one installation", async () => {
    const created = await plan();
    const request = {
      workspaceId,
      planId: created.id,
      checksum: created.checksum,
      expectedInstallationVersion: null,
      idempotencyKey: "concurrent-apply",
      principal,
    };

    const [first, second] = await Promise.all([
      lifecycle.apply(request),
      lifecycle.apply(request),
    ]);

    // The loser read the winner rather than reporting the plan stale for a request that
    // succeeded.
    expect(second.operation.id).toBe(first.operation.id);
    expect(second.installation.id).toBe(first.installation.id);
    expect(await countOf("app_installations")).toBe(1);
    expect(await countOf("app_lifecycle_operations")).toBe(1);
  });

  it("refuses to consume a plan against a release a concurrent revocation is committing", async () => {
    const created = await plan();
    const revoker = new Database(integrationDatabaseUrl);
    try {
      // The revocation holds the release row when the apply reaches for it, so the apply
      // blocks on that lock rather than reading a snapshot that predates it.
      await revoker.query("BEGIN");
      await revoker.query(`UPDATE app_releases SET state = 'revoked' WHERE id = $1`, [releaseId]);
      const applying = lifecycle.apply({
        workspaceId,
        planId: created.id,
        checksum: created.checksum,
        expectedInstallationVersion: null,
        idempotencyKey: "revoked-apply",
        principal,
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      await revoker.query("COMMIT");

      await expect(applying).rejects.toMatchObject({ reason: "release_not_eligible" });
    } finally {
      await revoker.close().catch(() => undefined);
    }

    const stored = await repositories.plans.findById(workspaceId, created.id);
    expect(stored!.consumedAt).toBeNull();
    expect(await countOf("app_installations")).toBe(0);
  });

  it("refuses to move the active pointer onto a release a concurrent revocation is committing", async () => {
    const { installationId, version } = await readyToActivate("revoked-activate");
    const revoker = new Database(integrationDatabaseUrl);
    try {
      // The revocation lands while the provider is working, and commits just as the
      // activation reaches for the release row.
      provisioning.provision.mockImplementationOnce(async () => {
        await revoker.query("BEGIN");
        await revoker.query(`UPDATE app_releases SET state = 'revoked' WHERE id = $1`, [releaseId]);
        setTimeout(() => {
          void revoker.query("COMMIT");
        }, 150);
        return { ok: true as const };
      });

      const outcome = await lifecycle.activate({
        workspaceId,
        installationId,
        expectedVersion: version,
        idempotencyKey: "revoked-activate-command",
        principal,
      });

      expect(outcome.operation.state).toBe("failed");
      const installation = await stateOf(installationId);
      expect(installation.state).not.toBe("active");
      expect(installation.activeReleaseId).toBeNull();
    } finally {
      await revoker.close().catch(() => undefined);
    }
  });

  it("hands a claimed audit batch to one dispatcher and delivers each event once", async () => {
    await apply("outbox-once");
    const pending = await database.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM app_audit_outbox WHERE workspace_id = $1 AND delivered_at IS NULL`,
      [workspaceId],
    );
    expect(pending[0].count).toBe(0);

    // Two dispatchers reach an undelivered backlog at the same moment, which is what
    // happens every time two Apps requests commit together.
    await database.query(
      `UPDATE app_audit_outbox SET delivered_at = NULL, claim_token = NULL WHERE workspace_id = $1`,
      [workspaceId],
    );
    const backlog = await database.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM app_audit_outbox WHERE workspace_id = $1`,
      [workspaceId],
    );
    audit.record.mockClear();
    const second = new AppAuditOutboxDispatcher({ outbox: repositories.auditOutbox, audit, logger });

    await Promise.all([auditDelivery.drainAll(), second.drainAll()]);

    // Each row was delivered by whichever dispatcher claimed it, and by only that one.
    expect(audit.record).toHaveBeenCalledTimes(backlog[0].count);
    const undelivered = await database.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM app_audit_outbox WHERE workspace_id = $1 AND delivered_at IS NULL`,
      [workspaceId],
    );
    expect(undelivered[0].count).toBe(0);
    // The outbox row id travels with the event, so a redelivery after a crash between the
    // sink call and the acknowledgement is recognisable as the same event.
    const delivered = audit.record.mock.calls.map(
      (call) => (call as unknown as [{ metadata?: { appAuditDeliveryId?: string } }])[0]
        .metadata?.appAuditDeliveryId,
    );
    expect(new Set(delivered).size).toBe(backlog[0].count);
  });

  it("reopens execution when a disabled installation is enabled again", async () => {
    const { installationId, version } = await readyToActivate("enable-eligibility");
    const activated = await lifecycle.activate({
      workspaceId,
      installationId,
      expectedVersion: version,
      idempotencyKey: "enable-eligibility-activate",
      principal,
    });
    const digest = (await repositories.releases.findById(releaseId))!.manifestDigest;
    const query = { installationId, contributionId: "site_content", expectedReleaseDigest: digest };
    await expect(eligibility.evaluate(query)).resolves.toMatchObject({ eligible: true });

    const disabled = await lifecycle.disable({
      workspaceId,
      installationId,
      expectedVersion: activated.installation.version,
      idempotencyKey: "enable-eligibility-disable",
      principal,
    });
    await expect(eligibility.evaluate(query)).resolves.toEqual({ eligible: false, reason: "execution_denied" });

    const enabled = await lifecycle.enable({
      workspaceId,
      installationId,
      expectedVersion: disabled.installation.version,
      idempotencyKey: "enable-eligibility-enable",
      principal,
    });

    expect(enabled.installation.state).toBe("active");
    // An installation that says it is active and refuses every invocation is the bug this
    // covers: going live has to reopen the gate teardown closed.
    expect(enabled.installation.executionDeniedAt).toBeNull();
    await expect(eligibility.evaluate(query)).resolves.toMatchObject({ eligible: true });
  });
});
