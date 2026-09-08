import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, expect, it } from "vitest";
import { appManifestSchema, type AppManifest } from "@radioso/app-contract";

import {
  AppConnectionRepository,
  AppGrantRepository,
  AppInstallationPlanRepository,
  AppInstallationRepository,
  AppLifecycleOperationRepository,
  AppReleaseRepository,
  appManifestDigest,
  buildAppInstallationPlan,
} from "../../../src/modules/apps/public.js";
import { createAppsUnitOfWork } from "../../../src/app/composition/apps.js";
import { Database } from "../../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "../support/integrationDatabase.js";

// Real-Postgres characterization of the Apps control plane's persistence: the constraints
// that make the domain's guarantees true rather than merely intended — one live
// installation per App, one live grant per key, one connection per slot, one operation per
// idempotency key, and an optimistic installation version that a stale writer loses.

const manifestPath = fileURLToPath(
  new URL("../../../../packages/app-contract/fixtures/reference/wordpress.manifest.json", import.meta.url),
);
const manifest = (): AppManifest => appManifestSchema.parse(
  JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>,
);

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("Apps control-plane repositories (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const releases = new AppReleaseRepository(database.kysely);
  const installations = new AppInstallationRepository(database.kysely);
  const plans = new AppInstallationPlanRepository(database.kysely);
  const grants = new AppGrantRepository(database.kysely);
  const connections = new AppConnectionRepository(database.kysely);
  const operations = new AppLifecycleOperationRepository(database.kysely);

  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const appId = `ai.radioso.test-${randomUUID()}`;

  const admit = async (version: string, digest = `sha256:${version.padEnd(64, "0")}`) => {
    const inserted = await releases.insertIfAbsent({
      appId,
      version,
      manifest: manifest(),
      manifestDigest: digest,
      artifactDigest: manifest().artifact.digest,
      publisherId: "ai.radioso",
      state: "admitted",
      admissionPolicyVersion: "release-a.1",
      admissionDecision: { evidence: { provenance: "built_in_registry" } },
    });
    return inserted ?? (await releases.findByAppIdAndVersion(appId, version))!;
  };

  beforeAll(async () => {
    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [accountId, "Apps Test Co", `acct-${accountId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [workspaceId, accountId, "Apps Workspace", `route-${workspaceId}`],
    );
  });

  afterAll(async () => {
    await database.query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => undefined);
    await database.query(`DELETE FROM app_releases WHERE app_id = $1`, [appId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("inserts a release once and never rewrites the row a later sync sees", async () => {
    const first = await admit("1.0.0");

    // A second sync of a version that already exists changes nothing about it. Start-up is
    // not a security decision, so a revoked release must not come back admitted.
    await releases.transitionState(first.id, "revoked");
    const again = await releases.insertIfAbsent({
      appId,
      version: "1.0.0",
      manifest: manifest(),
      manifestDigest: `sha256:${"c".repeat(64)}`,
      artifactDigest: manifest().artifact.digest,
      publisherId: "ai.radioso",
      state: "admitted",
      admissionPolicyVersion: "release-a.1",
      admissionDecision: {},
    });
    expect(again).toBeNull();

    const stored = await releases.findByAppIdAndVersion(appId, "1.0.0");
    expect(stored).toMatchObject({ id: first.id, state: "revoked", manifestDigest: first.manifestDigest });
    expect((await releases.listInstallable()).map((release) => release.id)).not.toContain(first.id);

    await releases.transitionState(first.id, "admitted");
    expect((await releases.listInstallable()).map((release) => release.id)).toContain(first.id);
  });

  it("allows one live installation of an App per workspace and reinstallation after removal", async () => {
    const release = await admit("2.0.0");
    const installation = await installations.create({
      workspaceId,
      appId: `${appId}.live`,
      candidateReleaseId: release.id,
      configuration: { site_url: "https://example.com" },
    });

    // Two different plans for the same App can both pass the service's pre-check before
    // either writes; the partial unique index on (workspace_id, app_id) WHERE state <>
    // 'removed' is what actually serializes the race, and the loser must see the domain
    // `installation_conflict` error, not a raw Postgres unique-violation.
    await expect(installations.create({
      workspaceId,
      appId: `${appId}.live`,
      candidateReleaseId: release.id,
      configuration: {},
    })).rejects.toMatchObject({ reason: "installation_conflict" });

    const removed = await installations.update(workspaceId, installation.id, installation.version, {
      state: "removed",
    });
    expect(removed?.state).toBe("removed");
    expect(await installations.findLiveByAppId(workspaceId, `${appId}.live`)).toBeNull();

    const reinstalled = await installations.create({
      workspaceId,
      appId: `${appId}.live`,
      candidateReleaseId: release.id,
      configuration: {},
    });
    expect(reinstalled.id).not.toBe(installation.id);
  });

  it("refuses a write that carries a stale installation version", async () => {
    const release = await admit("3.0.0");
    const installation = await installations.create({
      workspaceId,
      appId: `${appId}.optimistic`,
      candidateReleaseId: release.id,
      configuration: {},
    });

    const updated = await installations.update(workspaceId, installation.id, installation.version, {
      configuration: { site_url: "https://first.example" },
    });
    expect(updated?.version).toBe(installation.version + 1);

    expect(await installations.update(workspaceId, installation.id, installation.version, {
      configuration: { site_url: "https://second.example" },
    })).toBeNull();
  });

  it("lets exactly one applier consume a plan", async () => {
    const release = await admit("4.0.0");
    const { plan, checksum, expiresAt } = buildAppInstallationPlan({
      workspaceId,
      release: {
        id: release.id,
        appId: release.appId,
        version: release.version,
        manifestDigest: appManifestDigest(release.manifest),
        manifest: release.manifest,
        state: release.state,
        admissionPolicyVersion: release.admissionPolicyVersion,
      },
      configuration: { site_url: "https://example.com" },
      boundConnectionSlotIds: ["webhook_secret"],
      now: new Date(),
    });

    const record = await plans.create({ workspaceId, releaseId: release.id, checksum, plan, createdBy: null, expiresAt });
    expect((await plans.findById(workspaceId, record.id))?.checksum).toBe(checksum);
    // Another workspace must not read, let alone apply, this plan.
    expect(await plans.findById(randomUUID(), record.id)).toBeNull();

    expect(await plans.consume(workspaceId, record.id, new Date())).toBe(true);
    expect(await plans.consume(workspaceId, record.id, new Date())).toBe(false);
  });

  it("keeps one live grant per key and revokes them all at once", async () => {
    const release = await admit("5.0.0");
    const installation = await installations.create({
      workspaceId, appId: `${appId}.grants`, candidateReleaseId: release.id, configuration: {},
    });
    const approved = [
      { kind: "permission" as const, key: "documents.ingest" },
      { kind: "destination" as const, key: "site" },
    ];

    await grants.approve({
      installationId: installation.id, releaseId: release.id, planId: null, approvedBy: null, grants: approved,
    });
    // Re-approving the same plan is what a resumed saga does; it must not double the grants.
    await grants.approve({
      installationId: installation.id, releaseId: release.id, planId: null, approvedBy: null, grants: approved,
    });

    expect(await grants.listLive(installation.id)).toHaveLength(2);
    expect(await grants.revokeAll(installation.id, new Date())).toBe(2);
    expect(await grants.listLive(installation.id)).toEqual([]);
  });

  it("stores a connection secret as ciphertext the read path never returns", async () => {
    const release = await admit("6.0.0");
    const installation = await installations.create({
      workspaceId, appId: `${appId}.connections`, candidateReleaseId: release.id, configuration: {},
    });

    const bound = await connections.bind({
      installationId: installation.id,
      slotId: "site_credentials",
      kind: "secret_fields",
      publicFields: { wp_username: "editor" },
      secretCiphertext: "ciphertext-for-application-password",
      encryptionKeyId: "CONNECTOR_ENCRYPTION_KEY",
    });

    expect(bound.hasSecret).toBe(true);
    expect(JSON.stringify(bound)).not.toContain("ciphertext-for-application-password");

    // Re-binding the same slot rotates it rather than creating a second row.
    const rotated = await connections.bind({
      installationId: installation.id,
      slotId: "site_credentials",
      kind: "secret_fields",
      publicFields: { wp_username: "publisher" },
      secretCiphertext: "rotated-ciphertext",
      encryptionKeyId: "CONNECTOR_ENCRYPTION_KEY",
    });
    expect(rotated.id).toBe(bound.id);
    expect(rotated.rotatedAt).not.toBeNull();

    const listed = await connections.listByInstallation(installation.id);
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain("rotated-ciphertext");
    expect(listed[0].publicFields).toEqual({ wp_username: "publisher" });

    expect(await connections.markAllForDeletion(installation.id, new Date())).toBe(1);
    expect((await connections.listByInstallation(installation.id))[0].deletionRequestedAt).not.toBeNull();
  });

  it("treats one idempotency key as one operation and advances its durable cursor", async () => {
    const release = await admit("7.0.0");
    const installation = await installations.create({
      workspaceId, appId: `${appId}.operations`, candidateReleaseId: release.id, configuration: {},
    });
    const principal = { accountId, userId: randomUUID() };
    const idempotencyKey = `install-${randomUUID()}`;
    const start = { installationId: installation.id, kind: "install" as const, idempotencyKey, requestFingerprint: "sha256:abc", initiatedBy: principal, payload: {} };

    const started = await operations.start(start);
    const retried = await operations.start(start);
    expect(retried.operation.id).toBe(started.operation.id);
    expect(started.operation.initiatedBy).toEqual(principal);
    expect(started.operation.requestFingerprint).toBe("sha256:abc");

    const advanced = await operations.update(started.operation.id, { step: "provision_runtime" });
    expect(advanced.step).toBe("provision_runtime");
    // A resumed operation reads its cursor back exactly as the crashed process left it.
    expect((await operations.findByIdempotencyKey(idempotencyKey))?.step).toBe("provision_runtime");

    const failed = await operations.update(started.operation.id, {
      state: "failed", error: { reason: "runtime_unavailable", message: "No runtime provider" },
    });
    expect(failed.error).toEqual({ reason: "runtime_unavailable", message: "No runtime provider" });
    expect(await operations.listByInstallation(installation.id, 20)).toHaveLength(1);
  });

  /**
   * Two concurrent commands can both pass the service's read of "is anything running";
   * the partial unique index on (installation_id) WHERE state IN ('running',
   * 'compensating') is what actually decides which one owns the installation, and the
   * loser must see the domain refusal rather than a raw SQLSTATE.
   */
  it("allows one in-flight operation per installation and frees it once terminal", async () => {
    const release = await admit("8.0.0");
    const installation = await installations.create({
      workspaceId, appId: `${appId}.serialization`, candidateReleaseId: release.id, configuration: {},
    });
    const principal = { accountId, userId: randomUUID() };

    const first = await operations.start({
      installationId: installation.id,
      kind: "disable",
      idempotencyKey: `disable-${randomUUID()}`,
      requestFingerprint: "sha256:one",
      initiatedBy: principal,
      payload: {},
    });

    await expect(operations.start({
      installationId: installation.id,
      kind: "remove",
      idempotencyKey: `remove-${randomUUID()}`,
      requestFingerprint: "sha256:two",
      initiatedBy: principal,
      payload: {},
    })).rejects.toMatchObject({ reason: "operation_in_progress" });

    // Compensating still counts as in flight: a rollback owns the installation too.
    await operations.update(first.operation.id, { state: "compensating" });
    await expect(operations.start({
      installationId: installation.id,
      kind: "remove",
      idempotencyKey: `remove-${randomUUID()}`,
      requestFingerprint: "sha256:three",
      initiatedBy: principal,
      payload: {},
    })).rejects.toMatchObject({ reason: "operation_in_progress" });

    await operations.update(first.operation.id, { state: "compensation_failed" });
    const next = await operations.start({
      installationId: installation.id,
      kind: "remove",
      idempotencyKey: `remove-${randomUUID()}`,
      requestFingerprint: "sha256:four",
      initiatedBy: principal,
      payload: {},
    });
    expect(next.created).toBe(true);
  });

  it("advances a cursor only for the driver that still holds it", async () => {
    const release = await admit("9.0.0");
    const installation = await installations.create({
      workspaceId, appId: `${appId}.cursor`, candidateReleaseId: release.id, configuration: {},
    });
    const { operation } = await operations.start({
      installationId: installation.id,
      kind: "activate",
      idempotencyKey: `activate-${randomUUID()}`,
      requestFingerprint: "sha256:cas",
      initiatedBy: { accountId, userId: randomUUID() },
      payload: {},
    });

    const advanced = await operations.advance(operation.id, {
      expectedState: "running", expectedStep: null, step: "provision_runtime",
    });
    expect(advanced?.step).toBe("provision_runtime");

    // A second driver that still believes the cursor is null gets nothing back, which is
    // how it learns to stop rather than run the step again.
    expect(await operations.advance(operation.id, {
      expectedState: "running", expectedStep: null, step: "stage_contributions",
    })).toBeNull();

    await operations.update(operation.id, { state: "compensating" });
    expect(await operations.advanceCompensation(operation.id, {
      expectedCompensationStep: null, compensationStep: "provision_runtime",
    })).toMatchObject({ compensationStep: "provision_runtime" });
    expect(await operations.advanceCompensation(operation.id, {
      expectedCompensationStep: null, compensationStep: "stage_contributions",
    })).toBeNull();
  });

  /**
   * Applying a plan consumes the approval, creates the installation, and opens the
   * operation. A crash between any two of those would leave a consumed plan with nothing
   * to resume, or a live installation blocking every future install — so they commit
   * together or not at all.
   */
  it("rolls back the whole apply bootstrap when any part of it fails", async () => {
    const release = await admit("10.0.0");
    const unitOfWork = createAppsUnitOfWork(database.kysely);
    const { plan, checksum, expiresAt } = buildAppInstallationPlan({
      workspaceId,
      release: {
        id: release.id,
        appId: release.appId,
        version: release.version,
        manifestDigest: appManifestDigest(release.manifest),
        manifest: release.manifest,
        state: release.state,
        admissionPolicyVersion: release.admissionPolicyVersion,
      },
      configuration: { site_url: "https://example.com" },
      boundConnectionSlotIds: [],
      now: new Date(),
    });
    const record = await plans.create({
      workspaceId, releaseId: release.id, checksum, plan, createdBy: null, expiresAt,
    });
    const bootstrapAppId = `${appId}.bootstrap`;

    await expect(unitOfWork.run(async (repositories) => {
      expect(await repositories.plans.consume(workspaceId, record.id, new Date())).toBe(true);
      await repositories.installations.create({
        workspaceId,
        appId: bootstrapAppId,
        candidateReleaseId: release.id,
        configuration: plan.configuration,
      });
      throw new Error("the process died before the operation was opened");
    })).rejects.toThrow("the process died");

    expect((await plans.findById(workspaceId, record.id))?.consumedAt).toBeNull();
    expect(await installations.findLiveByAppId(workspaceId, bootstrapAppId)).toBeNull();

    // And the same work, uninterrupted, leaves a complete and resumable state.
    const bootstrapped = await unitOfWork.run(async (repositories) => {
      await repositories.plans.consume(workspaceId, record.id, new Date());
      const installation = await repositories.installations.create({
        workspaceId,
        appId: bootstrapAppId,
        candidateReleaseId: release.id,
        configuration: plan.configuration,
      });
      return repositories.operations.start({
        installationId: installation.id,
        kind: "install",
        idempotencyKey: `install-${randomUUID()}`,
        requestFingerprint: checksum,
        initiatedBy: { accountId, userId: randomUUID() },
        payload: { planId: record.id },
      });
    });
    expect(bootstrapped.operation.state).toBe("running");
    expect((await plans.findById(workspaceId, record.id))?.consumedAt).not.toBeNull();
  });

  it("never clears a deletion request when a connection is rebound", async () => {
    const release = await admit("11.0.0");
    const installation = await installations.create({
      workspaceId, appId: `${appId}.deletion`, candidateReleaseId: release.id, configuration: {},
    });
    await connections.bind({
      installationId: installation.id,
      slotId: "webhook_secret",
      kind: "generated_secret",
      publicFields: {},
      secretCiphertext: "ciphertext",
      encryptionKeyId: "CONNECTOR_ENCRYPTION_KEY",
    });
    await connections.markAllForDeletion(installation.id, new Date());

    const rebound = await connections.bind({
      installationId: installation.id,
      slotId: "webhook_secret",
      kind: "generated_secret",
      publicFields: {},
      secretCiphertext: "new-ciphertext",
      encryptionKeyId: "CONNECTOR_ENCRYPTION_KEY",
    });

    expect(rebound.deletionRequestedAt).not.toBeNull();
  });
});
