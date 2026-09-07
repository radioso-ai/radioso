import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import {
  AppConnectionService,
  AppInstallationLifecycleService,
  AppInstallationPlanService,
  AppInstallationQueryService,
  AppReleaseAdmissionService,
  appSagaSteps,
  createNoopAppManagedDataDisposition,
  createUnavailableAppRuntimeProvisioning,
  type AppContributionStagingPort,
  type AppLifecycleOperationRecord,
  type AppLifecycleOutcome,
  type AppOperatorAuthorizationPort,
  type AppRuntimeProvisioningPort,
  type AppSecretCipherPort,
} from "../../../src/modules/apps/public.js";
import { createLogger } from "../../../src/shared/observability/logger.js";
import { createInMemoryAppRepositories, type InMemoryAppRepositories } from "../../support/inMemoryApps.js";
import { wordpressArtifactCatalogue, wordpressManifestDocument } from "./support.js";

const workspaceId = "22222222-2222-4222-8222-222222222222";
const principal = { accountId: "33333333-3333-4333-8333-333333333333", userId: "44444444-4444-4444-8444-444444444444" };

const recordedEvents = (audit: { record: ReturnType<typeof vi.fn> }): string[] =>
  audit.record.mock.calls.map((call) => (call[0] as { eventType: string }).eventType);

const auditMetadata = (audit: { record: ReturnType<typeof vi.fn> }): unknown[] =>
  audit.record.mock.calls.map((call) => (call[0] as { metadata?: unknown }).metadata);

interface Harness {
  readonly repositories: InMemoryAppRepositories;
  readonly audit: { record: ReturnType<typeof vi.fn> };
  readonly authorization: AppOperatorAuthorizationPort & { allow: boolean };
  readonly staging: {
    stage: Mock<AppContributionStagingPort["stage"]>;
    runSafeTests: Mock<AppContributionStagingPort["runSafeTests"]>;
    detach: Mock<AppContributionStagingPort["detach"]>;
  };
  readonly provisioning: {
    provision: Mock<AppRuntimeProvisioningPort["provision"]>;
    deprovision: Mock<AppRuntimeProvisioningPort["deprovision"]>;
  };
  readonly lifecycle: AppInstallationLifecycleService;
  readonly plans: AppInstallationPlanService;
  readonly connections: AppConnectionService;
  readonly installations: AppInstallationQueryService;
  readonly cipher: AppSecretCipherPort;
  admitReference(): Promise<string>;
  install(overrides?: { idempotencyKey?: string }): Promise<AppLifecycleOutcome>;
}

const createHarness = async (): Promise<Harness> => {
  const repositories = createInMemoryAppRepositories();
  const audit = { record: vi.fn(async () => {}) };
  const logger = createLogger("silent");
  const authorization = {
    allow: true,
    requireAppAdministration: async () => {
      if (!authorization.allow) throw new Error("forbidden");
    },
  };
  const staging = {
    stage: vi.fn(async () => {}),
    runSafeTests: vi.fn(async () => {}),
    detach: vi.fn(async () => {}),
  };
  const provisioning = { provision: vi.fn(async () => {}), deprovision: vi.fn(async () => {}) };
  const cipher: AppSecretCipherPort = { keyId: "test", encrypt: (plaintext) => `enc(${plaintext})` };

  const releaseAdmission = new AppReleaseAdmissionService({
    releases: repositories.releases,
    builtInReleases: [{ manifest: wordpressManifestDocument(), artifactDigests: [...wordpressArtifactCatalogue()] }],
    audit,
    logger,
  });

  const plans = new AppInstallationPlanService({
    releases: repositories.releases,
    installations: repositories.installations,
    connections: repositories.connections,
    plans: repositories.plans,
    authorization,
    audit,
  });

  const lifecycle = new AppInstallationLifecycleService({
    installations: repositories.installations,
    plans: repositories.plans,
    releases: repositories.releases,
    grants: repositories.grants,
    connections: repositories.connections,
    operations: repositories.operations,
    runtimeProvisioning: provisioning,
    contributionStaging: staging,
    dataDisposition: createNoopAppManagedDataDisposition(),
    authorization,
    audit,
    logger,
  });

  const connections = new AppConnectionService({
    installations: repositories.installations,
    releases: repositories.releases,
    connections: repositories.connections,
    cipher,
    authorization,
    audit,
  });

  const installations = new AppInstallationQueryService({
    installations: repositories.installations,
    releases: repositories.releases,
    grants: repositories.grants,
    connections: repositories.connections,
    operations: repositories.operations,
    authorization,
    audit,
  });

  const admitReference = async () => {
    await releaseAdmission.syncBuiltInReleases();
    const [release] = await repositories.releases.listInstallable();
    return release.id;
  };

  const install = async (overrides: { idempotencyKey?: string } = {}) => {
    const releaseId = await admitReference();
    const plan = await plans.create({
      workspaceId,
      releaseId,
      configuration: { site_url: "https://example.com" },
      targetAgentIds: [],
      principal,
    });
    return lifecycle.apply({
      workspaceId,
      planId: plan.id,
      checksum: plan.checksum,
      expectedInstallationVersion: null,
      idempotencyKey: overrides.idempotencyKey ?? "install-1",
      principal,
    });
  };

  return {
    repositories,
    audit,
    authorization,
    staging,
    provisioning,
    lifecycle,
    plans,
    connections,
    installations,
    cipher,
    admitReference,
    install,
  };
};

const crashableSteps = ["provision_runtime", "stage_contributions", "run_safe_tests"] as const;

/**
 * A crash is the process disappearing mid-step: the effect may or may not have landed,
 * the durable cursor still names the last step that committed, and nothing gets to
 * record a failure or open compensation. Failing the write that opens compensation
 * leaves exactly that state behind, which is what a recovery driver later finds.
 */
const crashDuringStep = async (
  local: Harness,
  stepId: (typeof crashableSteps)[number],
): Promise<AppLifecycleOperationRecord> => {
  const ports = {
    provision_runtime: local.provisioning.provision,
    stage_contributions: local.staging.stage,
    run_safe_tests: local.staging.runSafeTests,
  };
  ports[stepId].mockImplementationOnce(() => {
    throw new Error(`interrupted at ${stepId}`);
  });

  const operations = local.repositories.operations;
  const commit = operations.update.bind(operations);
  const died = vi.spyOn(operations, "update").mockImplementation(async (id, patch) => {
    if (patch.state === "compensating") throw new Error("process died");
    return commit(id, patch);
  });

  await expect(local.install()).rejects.toThrow("process died");
  died.mockRestore();

  const operation = await operations.findByIdempotencyKey("install-1");
  if (!operation) throw new Error("the interrupted operation was not persisted");
  return operation;
};

describe("app installation lifecycle", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  it("installs to active, approves the plan's grants, and audits each family", async () => {
    const { installation, operation } = await harness.install();

    expect(installation.state).toBe("active");
    expect(installation.activeReleaseId).not.toBeNull();
    expect(installation.candidateReleaseId).toBeNull();
    expect(operation.state).toBe("completed");
    expect(operation.step).toBe("activate");
    expect((await harness.repositories.grants.listLive(installation.id)).length).toBeGreaterThan(0);
    expect(recordedEvents(harness.audit)).toEqual([
      "app.release.admitted",
      "app.installation.planned",
      "app.grant.approved",
      "app.installation.activated",
      "app.installation.installed",
    ]);
  });

  it("refuses a second installation of the same App in one workspace", async () => {
    await harness.install();

    await expect(harness.install({ idempotencyKey: "install-2" }))
      .rejects.toMatchObject({ reason: "installation_conflict" });
  });

  it("treats a repeated apply of one plan as one saga", async () => {
    const first = await harness.install();
    const releaseId = await harness.admitReference();
    const plan = await harness.plans.create({
      workspaceId,
      releaseId,
      configuration: { site_url: "https://example.com" },
      targetAgentIds: [],
      principal,
    });

    const retried = await harness.lifecycle.apply({
      workspaceId,
      planId: plan.id,
      checksum: plan.checksum,
      expectedInstallationVersion: null,
      idempotencyKey: "install-1",
      principal,
    });

    expect(retried.operation.id).toBe(first.operation.id);
    expect(harness.repositories.installations.rows.size).toBe(1);
  });

  it("leaves an actionable failure when no runtime provider is configured", async () => {
    const harnessWithoutRuntime = await createHarness();
    const unavailable = createUnavailableAppRuntimeProvisioning();
    harnessWithoutRuntime.provisioning.provision.mockImplementation(unavailable.provision);

    const { installation, operation } = await harnessWithoutRuntime.install();

    expect(installation.state).toBe("failed");
    expect(operation.state).toBe("failed");
    expect(operation.error?.reason).toBe("runtime_unavailable");
    expect(operation.error?.message).toContain("Configure a runtime provider");
    // Nothing was staged, and the grants the failed step approved are compensated away.
    expect(harnessWithoutRuntime.staging.stage).not.toHaveBeenCalled();
    expect(await harnessWithoutRuntime.repositories.grants.listLive(installation.id)).toEqual([]);
    expect(recordedEvents(harnessWithoutRuntime.audit)).toContain("app.installation.failed");
  });

  it("resumes from the durable cursor after a crash at every interruptible install step", async () => {
    for (const stepId of crashableSteps) {
      const local = await createHarness();
      const crashed = await crashDuringStep(local, stepId);

      const index = appSagaSteps.install.findIndex((step) => step.id === stepId);
      expect(crashed.state).toBe("running");
      expect(crashed.step).toBe(appSagaSteps.install[index - 1]?.id ?? null);

      const resumed = await local.lifecycle.resumeById(workspaceId, crashed.id);

      expect(resumed.operation.state).toBe("completed");
      expect(resumed.operation.step).toBe("activate");
      expect(resumed.installation.state).toBe("active");
      // Only the step that was in flight runs twice: everything the cursor already
      // covers is skipped, and nothing after it ran before the crash.
      expect(local.provisioning.provision).toHaveBeenCalledTimes(stepId === "provision_runtime" ? 2 : 1);
      expect(local.staging.stage).toHaveBeenCalledTimes(stepId === "stage_contributions" ? 2 : 1);
      expect(local.staging.runSafeTests).toHaveBeenCalledTimes(stepId === "run_safe_tests" ? 2 : 1);
    }
  });

  it("refuses to re-drive an operation that already failed and compensated", async () => {
    harness.staging.stage.mockImplementationOnce(() => {
      throw new Error("staging rejected the contribution");
    });
    const failed = await harness.install();
    expect(failed.operation.state).toBe("failed");
    expect(failed.installation.state).toBe("failed");
    // Compensation already undid provisioning and the approved grants, so the cursor
    // no longer describes anything a resume could safely continue from.
    expect(harness.provisioning.deprovision).toHaveBeenCalledTimes(1);
    expect(await harness.repositories.grants.listLive(failed.installation.id)).toEqual([]);

    const resumed = await harness.lifecycle.resumeById(workspaceId, failed.operation.id);

    expect(resumed.operation.state).toBe("failed");
    expect(harness.staging.stage).toHaveBeenCalledTimes(1);
    expect(harness.staging.runSafeTests).not.toHaveBeenCalled();
  });

  it("refuses to resume a privileged step for a principal who lost access", async () => {
    const crashed = await crashDuringStep(harness, "stage_contributions");

    harness.authorization.allow = false;
    const resumed = await harness.lifecycle.resumeById(workspaceId, crashed.id);

    expect(resumed.operation.state).toBe("failed");
    expect(resumed.operation.error?.reason).toBe("initiating_principal_unauthorized");
    expect(harness.staging.stage).toHaveBeenCalledTimes(1);
  });

  it("disables, re-enables, and removes an installation", async () => {
    const installed = await harness.install();

    const disabled = await harness.lifecycle.disable({
      workspaceId, installationId: installed.installation.id, idempotencyKey: "disable-1", principal,
    });
    expect(disabled.installation.state).toBe("disabled");
    expect(harness.provisioning.deprovision).toHaveBeenCalledTimes(1);

    const enabled = await harness.lifecycle.enable({
      workspaceId, installationId: installed.installation.id, idempotencyKey: "enable-1", principal,
    });
    expect(enabled.installation.state).toBe("active");

    const removed = await harness.lifecycle.remove({
      workspaceId, installationId: installed.installation.id, idempotencyKey: "remove-1", principal, disposition: "delete",
    });
    expect(removed.installation.state).toBe("removed");
    expect(await harness.repositories.grants.listLive(installed.installation.id)).toEqual([]);
    expect(recordedEvents(harness.audit)).toContain("app.grant.revoked");
    expect(recordedEvents(harness.audit)).toContain("app.installation.removed");
  });

  it("refuses a second command against an installation with an operation already in flight", async () => {
    const installed = await harness.install();
    // Simulate a saga left mid-flight (e.g. a crashed process) without driving it to
    // completion, so a second, differently-keyed command finds it still running.
    await harness.repositories.operations.start({
      installationId: installed.installation.id,
      kind: "disable",
      idempotencyKey: "disable-inflight",
      initiatedBy: principal,
      payload: {},
    });

    await expect(harness.lifecycle.disable({
      workspaceId, installationId: installed.installation.id, idempotencyKey: "disable-race", principal,
    })).rejects.toMatchObject({ reason: "operation_in_progress" });
  });

  it("resumes rather than refuses when the retry carries the in-flight operation's own idempotency key", async () => {
    const installed = await harness.install();
    const { operation: seeded } = await harness.repositories.operations.start({
      installationId: installed.installation.id,
      kind: "disable",
      idempotencyKey: "disable-replay",
      initiatedBy: principal,
      payload: {},
    });

    const replayed = await harness.lifecycle.disable({
      workspaceId, installationId: installed.installation.id, idempotencyKey: "disable-replay", principal,
    });

    expect(replayed.operation.id).toBe(seeded.id);
    expect(replayed.operation.state).toBe("completed");
    expect(replayed.installation.state).toBe("disabled");
  });

  it("lets a new command proceed once the installation's prior operation has completed", async () => {
    const installed = await harness.install();
    const disabled = await harness.lifecycle.disable({
      workspaceId, installationId: installed.installation.id, idempotencyKey: "disable-2", principal,
    });
    expect(disabled.operation.state).toBe("completed");

    const enabled = await harness.lifecycle.enable({
      workspaceId, installationId: installed.installation.id, idempotencyKey: "enable-2", principal,
    });
    expect(enabled.installation.state).toBe("active");
  });

  it("marks connections for deletion before disposing managed data", async () => {
    const installed = await harness.install();
    await harness.connections.bind({
      workspaceId, installationId: installed.installation.id, slotId: "webhook_secret", values: {}, principal,
    });

    await harness.lifecycle.remove({
      workspaceId, installationId: installed.installation.id, idempotencyKey: "remove-2", principal, disposition: "export",
    });

    const connections = await harness.repositories.connections.listByInstallation(installed.installation.id);
    expect(connections[0].deletionRequestedAt).not.toBeNull();
  });

  it("re-checks the current principal on every mutation", async () => {
    const installed = await harness.install();
    harness.authorization.allow = false;

    await expect(harness.lifecycle.disable({
      workspaceId, installationId: installed.installation.id, idempotencyKey: "disable-2", principal,
    })).rejects.toThrow();
    await expect(harness.plans.create({
      workspaceId, releaseId: installed.installation.activeReleaseId!, configuration: {}, targetAgentIds: [], principal,
    })).rejects.toThrow();
    await expect(harness.connections.bind({
      workspaceId, installationId: installed.installation.id, slotId: "webhook_secret", values: {}, principal,
    })).rejects.toThrow();
    await expect(harness.installations.updateConfiguration({
      workspaceId,
      installationId: installed.installation.id,
      configuration: { site_url: "https://example.com" },
      expectedVersion: installed.installation.version,
      principal,
    })).rejects.toThrow();
  });

  // FR-027a names plan inspection alongside approval: what an operator is shown here is
  // what apply binds to, so reading it back is a protected read rather than a free one.
  it("re-checks the current principal when a plan is read back", async () => {
    const releaseId = await harness.admitReference();
    const created = await harness.plans.create({
      workspaceId, releaseId, configuration: { site_url: "https://example.com" }, targetAgentIds: [], principal,
    });

    await expect(harness.plans.get(workspaceId, created.id, principal)).resolves.toMatchObject({ id: created.id });

    harness.authorization.allow = false;
    await expect(harness.plans.get(workspaceId, created.id, principal)).rejects.toThrow();
  });
});

describe("app connections through the service", () => {
  it("mints a generated secret once, stores it encrypted, and never reads it back", async () => {
    const harness = await createHarness();
    const installed = await harness.install();

    const bound = await harness.connections.bind({
      workspaceId, installationId: installed.installation.id, slotId: "webhook_secret", values: {}, principal,
    });

    expect(bound.generatedSecret).toBeTruthy();
    expect(bound.connection.hasSecret).toBe(true);
    const stored = harness.repositories.connections.rows[0];
    expect(stored.secretCiphertext).toBe(`enc(${bound.generatedSecret})`);

    const listed = await harness.connections.list(installed.installation.id);
    expect(JSON.stringify(listed)).not.toContain(bound.generatedSecret!);

    const view = await harness.installations.get(workspaceId, installed.installation.id);
    expect(JSON.stringify(view)).not.toContain(bound.generatedSecret!);
    expect(JSON.stringify(auditMetadata(harness.audit))).not.toContain(bound.generatedSecret!);
  });

  it("keeps a sensitive field out of every readable surface", async () => {
    const harness = await createHarness();
    const installed = await harness.install();

    const bound = await harness.connections.bind({
      workspaceId,
      installationId: installed.installation.id,
      slotId: "site_credentials",
      values: { wp_username: "editor", wp_application_password: "hunter2" },
      principal,
    });

    expect(bound.generatedSecret).toBeNull();
    expect(bound.connection.publicFields).toEqual({ wp_username: "editor" });
    expect(JSON.stringify(bound)).not.toContain("hunter2");
    expect(JSON.stringify(auditMetadata(harness.audit))).not.toContain("hunter2");
  });

  it("refuses a slot the release does not declare", async () => {
    const harness = await createHarness();
    const installed = await harness.install();

    await expect(harness.connections.bind({
      workspaceId, installationId: installed.installation.id, slotId: "nonexistent", values: {}, principal,
    })).rejects.toMatchObject({ reason: "connection_slot_unknown" });
  });
});

describe("app installation plans", () => {
  it("rejects an apply whose checksum no longer matches the approved plan", async () => {
    const harness = await createHarness();
    const releaseId = await harness.admitReference();
    const plan = await harness.plans.create({
      workspaceId, releaseId, configuration: { site_url: "https://example.com" }, targetAgentIds: [], principal,
    });

    await expect(harness.lifecycle.apply({
      workspaceId,
      planId: plan.id,
      checksum: "sha256:not-the-approved-plan",
      expectedInstallationVersion: null,
      idempotencyKey: "install-x",
      principal,
    })).rejects.toMatchObject({ reason: "plan_stale", details: { cause: "checksum_mismatch" } });
  });

  // Configuration decides which contributions run. Turning polling on without the
  // credentials it needs would start a schedule that fails on its first tick, with
  // nothing on the installation saying why.
  it("refuses a configuration change that turns on a contribution whose connection is unbound", async () => {
    const harness = await createHarness();
    const installed = await harness.install();

    await expect(harness.installations.updateConfiguration({
      workspaceId,
      installationId: installed.installation.id,
      configuration: { site_url: "https://example.com", poll_interval_sec: 900 },
      expectedVersion: installed.installation.version,
      principal,
    })).rejects.toMatchObject({ reason: "connection_unbound" });

    await harness.connections.bind({
      workspaceId,
      installationId: installed.installation.id,
      slotId: "site_credentials",
      values: { wp_username: "editor", wp_application_password: "hunter2" },
      principal,
    });

    const updated = await harness.installations.updateConfiguration({
      workspaceId,
      installationId: installed.installation.id,
      configuration: { site_url: "https://example.com", poll_interval_sec: 900 },
      expectedVersion: installed.installation.version,
      principal,
    });
    expect(updated.configuration.poll_interval_sec).toBe(900);
    // Distinct from the install-completion event the lifecycle saga emits under the same
    // family, so an audit reader cannot confuse "installed" with "reconfigured".
    const events = recordedEvents(harness.audit);
    expect(events[events.length - 1]).toBe("app.installation.configuration_updated");
    expect(events.filter((event) => event === "app.installation.installed")).toHaveLength(1);
  });

  // A live installation's configuration goes through the same `resolveConfiguration` the
  // plan does — there is no separate, looser rule for an edit versus a first install.
  it("refuses a configuration update that drops a required field or breaks the schedule's range", async () => {
    const harness = await createHarness();
    const installed = await harness.install();

    await expect(harness.installations.updateConfiguration({
      workspaceId,
      installationId: installed.installation.id,
      configuration: { poll_interval_sec: 300 },
      expectedVersion: installed.installation.version,
      principal,
    })).rejects.toMatchObject({ reason: "invalid_configuration" });

    // The schedule this field drives runs 60 to 86400 seconds; 30 is neither in range nor
    // the 0 sentinel that leaves it off.
    await expect(harness.installations.updateConfiguration({
      workspaceId,
      installationId: installed.installation.id,
      configuration: { site_url: "https://example.com", poll_interval_sec: 30 },
      expectedVersion: installed.installation.version,
      principal,
    })).rejects.toMatchObject({ reason: "invalid_configuration" });
  });

  it("refuses to plan at all when a secret arrives as a configuration value", async () => {
    const harness = await createHarness();
    const releaseId = await harness.admitReference();

    await expect(harness.plans.create({
      workspaceId,
      releaseId,
      configuration: { site_url: "https://example.com", wp_application_password: "hunter2" },
      targetAgentIds: [],
      principal,
    })).rejects.toMatchObject({ reason: "invalid_configuration" });

    // Nothing was persisted, so the secret exists nowhere the plan could carry it.
    expect(harness.repositories.plans.rows.size).toBe(0);
  });

  it("counts a host-minted slot as satisfied so planning is not blocked on a value only the host can make", async () => {
    const harness = await createHarness();
    const releaseId = await harness.admitReference();

    const plan = await harness.plans.create({
      workspaceId, releaseId, configuration: { site_url: "https://example.com" }, targetAgentIds: [], principal,
    });

    expect(plan.plan.unresolvedRequirements).toEqual([]);
  });
});
