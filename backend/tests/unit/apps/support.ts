import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { vi, type Mock } from "vitest";

import { appManifestSchema, type AppManifest } from "@radioso/app-contract";

import {
  AppConnectionService,
  AppExecutionEligibilityService,
  AppInstallationLifecycleService,
  AppInstallationPlanService,
  AppInstallationQueryService,
  AppReleaseAdmissionService,
  type AppContributionStagingPort,
  type AppLifecycleOutcome,
  type AppOperatorAuthorizationPort,
  type AppRuntimeProvisioningPort,
  type AppSecretCipherPort,
} from "../../../src/modules/apps/public.js";
import { createLogger } from "../../../src/shared/observability/logger.js";
import type { AppLeaseTimer } from "../../../src/modules/apps/services/appStepLease.js";
import { AppAuditOutboxDispatcher } from "../../../src/modules/apps/services/appAuditOutboxDispatcher.js";
import {
  createInMemoryAppRepositories,
  createNonTransactionalInMemoryAppsUnitOfWork,
  type InMemoryAppRepositories,
} from "../../support/inMemoryApps.js";

const fixturePath = fileURLToPath(
  new URL("../../../../packages/app-contract/fixtures/reference/wordpress.manifest.json", import.meta.url),
);

/** The reference manifest every Apps test uses as its sample release. */
export const wordpressManifestDocument = (): Record<string, unknown> =>
  JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, unknown>;

export const wordpressManifest = (): AppManifest => appManifestSchema.parse(wordpressManifestDocument());

/** Both digests the reference manifest references, as a built-in registry would vouch for them. */
export const wordpressArtifactCatalogue = (): ReadonlySet<string> => {
  const manifest = wordpressManifest();
  return new Set([
    manifest.artifact.digest,
    ...(manifest.companionAssets ?? []).map((asset) => asset.digest),
  ]);
};

/** The version the reference manifest's `radiosoCompatibility` range admits. */
export const RUNNING_RADIOSO_VERSION = "0.1.0";

export const APPS_TEST_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
export const APPS_TEST_PRINCIPAL = {
  accountId: "33333333-3333-4333-8333-333333333333",
  userId: "44444444-4444-4444-8444-444444444444",
};

export const recordedEvents = (audit: { record: Mock }): string[] =>
  audit.record.mock.calls.map((call) => (call[0] as { eventType: string }).eventType);

export const auditMetadata = (audit: { record: Mock }): unknown[] =>
  audit.record.mock.calls.map((call) => (call[0] as { metadata?: unknown }).metadata);

export interface AppsHarness {
  readonly repositories: InMemoryAppRepositories;
  readonly audit: { record: Mock };
  readonly logs: Array<Record<string, unknown>>;
  readonly authorization: AppOperatorAuthorizationPort & { allow: boolean; indeterminate: boolean };
  readonly staging: {
    stage: Mock<AppContributionStagingPort["stage"]>;
    runSafeTests: Mock<AppContributionStagingPort["runSafeTests"]>;
    detach: Mock<AppContributionStagingPort["detach"]>;
    promote: Mock<AppContributionStagingPort["promote"]>;
    discardCandidate: Mock<AppContributionStagingPort["discardCandidate"]>;
  };
  readonly provisioning: {
    provision: Mock<AppRuntimeProvisioningPort["provision"]>;
    deprovision: Mock<AppRuntimeProvisioningPort["deprovision"]>;
  };
  readonly disposition: { dispose: Mock };
  readonly lifecycle: AppInstallationLifecycleService;
  readonly releaseAdmission: AppReleaseAdmissionService;
  readonly plans: AppInstallationPlanService;
  readonly connections: AppConnectionService;
  readonly installations: AppInstallationQueryService;
  readonly eligibility: AppExecutionEligibilityService;
  readonly cipher: AppSecretCipherPort;
  admitReference(): Promise<string>;
  /** Plan and apply. The installation exists, holds its grants, and runs nothing yet. */
  apply(overrides?: { idempotencyKey?: string }): Promise<AppLifecycleOutcome>;
  /** The whole setup phase: apply, bind the release's required slot, then activate. */
  install(overrides?: { idempotencyKey?: string }): Promise<AppLifecycleOutcome>;
}

interface AppsHarnessOptions {
  readonly runningRadiosoVersion?: string | null;
  /**
   * Drives the step heartbeat. The default is the real one, whose first tick is minutes
   * away; a test that needs a lease to lapse mid-call supplies one that ticks at once.
   */
  readonly leaseTimer?: AppLeaseTimer;
}

/** Every heartbeat interval elapses immediately, so a test never waits out a real lease. */
export const immediateLeaseTimer = (): AppLeaseTimer => ({
  delay: () => ({ elapsed: Promise.resolve(), cancel: () => {} }),
});

/**
 * One assembled Apps control plane over in-memory persistence. Every test that exercises
 * more than a pure function builds its own, so a failing case can be read without
 * carrying state from the case before it.
 */
export const createAppsHarness = async (options: AppsHarnessOptions = {}): Promise<AppsHarness> => {
  const repositories = createInMemoryAppRepositories();
  const unitOfWork = createNonTransactionalInMemoryAppsUnitOfWork(repositories);
  const audit = { record: vi.fn(async () => {}) };
  const logs: Array<Record<string, unknown>> = [];
  const logger = createLogger("warn", {
    write: (line: string) => {
      logs.push(JSON.parse(line) as Record<string, unknown>);
    },
  });
  const auditDelivery = new AppAuditOutboxDispatcher({
    outbox: repositories.auditOutbox,
    audit,
    logger,
  });
  const authorization = {
    allow: true,
    indeterminate: false,
    authorizeAppAdministration: async () => {
      if (authorization.indeterminate) return { ok: false as const, outcome: "indeterminate" as const };
      return authorization.allow ? { ok: true as const } : { ok: false as const, outcome: "denied" as const };
    },
  };
  const staging = {
    stage: vi.fn(async () => ({ ok: true as const })),
    runSafeTests: vi.fn(async () => ({ ok: true as const })),
    detach: vi.fn(async () => ({ ok: true as const })),
    promote: vi.fn(async () => ({ ok: true as const })),
    discardCandidate: vi.fn(async () => ({ ok: true as const })),
  };
  const provisioning = {
    provision: vi.fn(async () => ({ ok: true as const })),
    deprovision: vi.fn(async () => ({ ok: true as const })),
  };
  const disposition = { dispose: vi.fn(async () => ({ ok: true as const })) };
  const cipher: AppSecretCipherPort = { keyId: "test", encrypt: (plaintext) => `enc(${plaintext})` };
  const runningRadiosoVersion = options.runningRadiosoVersion === undefined
    ? RUNNING_RADIOSO_VERSION
    : options.runningRadiosoVersion;

  const releaseAdmission = new AppReleaseAdmissionService({
    releases: repositories.releases,
    unitOfWork,
    builtInReleases: [{ manifest: wordpressManifestDocument(), artifactDigests: [...wordpressArtifactCatalogue()] }],
    auditDelivery,
    logger,
    runningRadiosoVersion,
  });

  const plans = new AppInstallationPlanService({
    releases: repositories.releases,
    installations: repositories.installations,
    connections: repositories.connections,
    plans: repositories.plans,
    authorization,
    unitOfWork,
    auditDelivery,
    runningRadiosoVersion,
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
    dataDisposition: disposition,
    authorization,
    auditDelivery,
    logger,
    runningRadiosoVersion,
    leaseTimer: options.leaseTimer,
  });

  const connections = new AppConnectionService({
    installations: repositories.installations,
    releases: repositories.releases,
    connections: repositories.connections,
    operations: repositories.operations,
    unitOfWork,
    cipher,
    authorization,
    auditDelivery,
    runningRadiosoVersion,
  });

  const installations = new AppInstallationQueryService({
    installations: repositories.installations,
    releases: repositories.releases,
    grants: repositories.grants,
    connections: repositories.connections,
    operations: repositories.operations,
  });

  const eligibility = new AppExecutionEligibilityService({
    unitOfWork,
    runningRadiosoVersion,
  });

  const admitReference = async () => {
    await releaseAdmission.syncBuiltInReleases();
    const [release] = await repositories.releases.listInstallable();
    return release.id;
  };

  const apply = async (overrides: { idempotencyKey?: string } = {}) => {
    const releaseId = await admitReference();
    const plan = await plans.create({
      workspaceId: APPS_TEST_WORKSPACE_ID,
      releaseId,
      configuration: { site_url: "https://example.com" },
      principal: APPS_TEST_PRINCIPAL,
    });
    return lifecycle.apply({
      workspaceId: APPS_TEST_WORKSPACE_ID,
      planId: plan.id,
      checksum: plan.checksum,
      expectedInstallationVersion: null,
      idempotencyKey: overrides.idempotencyKey ?? "install-1",
      principal: APPS_TEST_PRINCIPAL,
    });
  };

  const install = async (overrides: { idempotencyKey?: string } = {}) => {
    const applied = await apply(overrides);
    const bound = await connections.bind({
      workspaceId: APPS_TEST_WORKSPACE_ID,
      installationId: applied.installation.id,
      slotId: "webhook_secret",
      values: {},
      expectedVersion: applied.installation.version,
      idempotencyKey: "bind-15",
      principal: APPS_TEST_PRINCIPAL,
    });
    void bound;
    const current = await repositories.installations.findById(
      APPS_TEST_WORKSPACE_ID,
      applied.installation.id,
    );
    return lifecycle.activate({
      workspaceId: APPS_TEST_WORKSPACE_ID,
      installationId: applied.installation.id,
      expectedVersion: current!.version,
      idempotencyKey: `${overrides.idempotencyKey ?? "install-1"}-activate`,
      principal: APPS_TEST_PRINCIPAL,
    });
  };

  return {
    repositories,
    audit,
    logs,
    authorization,
    staging,
    provisioning,
    disposition,
    lifecycle,
    releaseAdmission,
    plans,
    connections,
    installations,
    eligibility,
    cipher,
    admitReference,
    apply,
    install,
  };
};
