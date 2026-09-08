import { describe, expect, it, vi } from "vitest";

import {
  appSagaSteps,
  type AppLifecycleOperationRecord,
} from "../../../src/modules/apps/public.js";
import {
  APPS_TEST_PRINCIPAL as principal,
  APPS_TEST_WORKSPACE_ID as workspaceId,
  auditMetadata,
  createAppsHarness,
  recordedEvents,
  type AppsHarness,
} from "./support.js";

const activateSteps = ["provision_runtime", "stage_contributions", "run_safe_tests"] as const;

/**
 * A crash is the process disappearing mid-step: the effect may or may not have landed,
 * the durable cursor still names the last step that committed, and nothing gets to record
 * a failure or open compensation. Failing the write that opens compensation leaves exactly
 * that state behind, which is what a recovery driver later finds.
 */
const crashDuringActivation = async (
  harness: AppsHarness,
  stepId: (typeof activateSteps)[number],
): Promise<{ operation: AppLifecycleOperationRecord; installationId: string }> => {
  const applied = await harness.apply();
  await harness.connections.bind({
    workspaceId,
    installationId: applied.installation.id,
    slotId: "webhook_secret",
    values: {},
    expectedVersion: applied.installation.version,
    principal,
  });
  const current = await harness.repositories.installations.findById(workspaceId, applied.installation.id);

  const ports = {
    provision_runtime: harness.provisioning.provision,
    stage_contributions: harness.staging.stage,
    run_safe_tests: harness.staging.runSafeTests,
  };
  ports[stepId].mockImplementationOnce(() => {
    throw new Error(`interrupted at ${stepId}`);
  });

  const operations = harness.repositories.operations;
  const finish = operations.finish.bind(operations);
  const died = vi.spyOn(operations, "finish").mockImplementation(async (id, input) => {
    if (input.state === "compensating") throw new Error("process died");
    return finish(id, input);
  });

  await expect(harness.lifecycle.activate({
    workspaceId,
    installationId: applied.installation.id,
    expectedVersion: current!.version,
    idempotencyKey: "activate-1",
    principal,
  })).rejects.toThrow("process died");
  died.mockRestore();

  const operation = await operations.findByIdempotencyKey(workspaceId, "activate-1");
  if (!operation) throw new Error("the interrupted operation was not persisted");
  // Recovery happens after the dead driver's short lease has elapsed. A live second
  // driver must not be allowed to steal it merely because it presents a new process id.
  operations.rows.set(operation.id, { ...operation, leaseOwner: null, leaseExpiresAt: null });
  return { operation: (await operations.findById(operation.id))!, installationId: applied.installation.id };
};

describe("app installation setup phase", () => {
  it("applies a plan into a durable planned installation without starting anything", async () => {
    const harness = await createAppsHarness();

    const { installation, operation } = await harness.apply();

    expect(installation.state).toBe("planned");
    expect(operation.kind).toBe("install");
    expect(operation.state).toBe("completed");
    expect((await harness.repositories.grants.listLive(installation.id)).length).toBeGreaterThan(0);
    // Nothing outside the database happened, so there is nothing to undo if the operator
    // never finishes setting the App up.
    expect(harness.provisioning.provision).not.toHaveBeenCalled();
    expect(harness.staging.stage).not.toHaveBeenCalled();
  });

  it("refuses activation while a required connection has no record, naming the slot", async () => {
    const harness = await createAppsHarness();
    const { installation } = await harness.apply();

    await expect(harness.lifecycle.activate({
      workspaceId,
      installationId: installation.id,
      expectedVersion: installation.version,
      idempotencyKey: "activate-1",
      principal,
    })).rejects.toMatchObject({
      reason: "connections_unbound",
      details: { slotIds: "webhook_secret" },
    });
    expect(harness.provisioning.provision).not.toHaveBeenCalled();
  });

  it("plans a host-minted slot as an open requirement rather than as already satisfied", async () => {
    const harness = await createAppsHarness();
    const releaseId = await harness.admitReference();

    const plan = await harness.plans.create({
      workspaceId,
      releaseId,
      configuration: { site_url: "https://example.com" },
      principal,
    });

    expect(plan.plan.unresolvedRequirements).toEqual([
      expect.objectContaining({ code: "connection_unbound", path: "connections.slots.webhook_secret" }),
    ]);
    expect(plan.plan.connectionSlots).toContainEqual(
      expect.objectContaining({ slotId: "webhook_secret", required: true, bound: false }),
    );
  });

  it("activates once the minted secret exists, and audits every family", async () => {
    const harness = await createAppsHarness();

    const { installation, operation } = await harness.install();

    expect(installation.state).toBe("active");
    expect(installation.activeReleaseId).not.toBeNull();
    expect(installation.candidateReleaseId).toBeNull();
    expect(operation.kind).toBe("activate");
    expect(operation.state).toBe("completed");
    expect(operation.step).toBe("activate");
    expect(recordedEvents(harness.audit)).toEqual([
      "app.release.admitted",
      "app.installation.planned",
      "app.grant.approved",
      "app.installation.installed",
      "app.connection.bound",
      "app.installation.activated",
    ]);
  });

  it("attributes every human-triggered audit event to the administrator who asked", async () => {
    const harness = await createAppsHarness();
    await harness.install();

    for (const metadata of auditMetadata(harness.audit).slice(1)) {
      expect(metadata).toMatchObject({ actorUserId: principal.userId });
    }
  });
});

describe("app lifecycle operation serialization", () => {
  it("lets one of two drivers own a step and leaves the losing driver effect-free", async () => {
    const harness = await createAppsHarness();
    const installed = await harness.install();
    harness.provisioning.provision.mockClear();
    harness.provisioning.deprovision.mockClear();
    const operation = await harness.repositories.operations.reserve({
      workspaceId,
      installationId: installed.installation.id,
      kind: "disable",
      idempotencyKey: "two-drivers-disable",
      requestFingerprint: "same-request",
      initiatedBy: principal,
      payload: {},
    });
    if (!operation) throw new Error("test operation was not reserved");

    const [first, second] = await Promise.all([
      harness.lifecycle.resumeById(workspaceId, operation.id),
      harness.lifecycle.resumeById(workspaceId, operation.id),
    ]);

    expect(harness.provisioning.deprovision).toHaveBeenCalledTimes(1);
    expect(harness.provisioning.provision).not.toHaveBeenCalled();
    expect([first.operation.state, second.operation.state]).toContain("completed");
  });

  it("refuses a second command against an installation with an operation already in flight", async () => {
    const harness = await createAppsHarness();
    const installed = await harness.install();
    await harness.repositories.operations.start({
      installationId: installed.installation.id,
      kind: "disable",
      idempotencyKey: "disable-inflight",
      requestFingerprint: "fingerprint-a",
      initiatedBy: principal,
      payload: {},
    });

    await expect(harness.lifecycle.disable({
      workspaceId,
      installationId: installed.installation.id,
      expectedVersion: installed.installation.version,
      idempotencyKey: "disable-race",
      principal,
    })).rejects.toMatchObject({ reason: "operation_in_progress" });
  });

  it("stops a driver whose cursor compare-and-set no longer matches, rather than repeating a step", async () => {
    const harness = await createAppsHarness();
    const installed = await harness.install();
    const operations = harness.repositories.operations;

    const { operation } = await operations.start({
      installationId: installed.installation.id,
      kind: "disable",
      idempotencyKey: "disable-handover",
      requestFingerprint: "fingerprint-b",
      initiatedBy: principal,
      payload: {},
    });
    // Another driver advanced the operation between this one reading it and committing.
    vi.spyOn(operations, "advance").mockResolvedValueOnce(null);
    harness.provisioning.deprovision.mockClear();

    const outcome = await harness.lifecycle.resumeById(workspaceId, operation.id);

    expect(outcome.operation.state).toBe("running");
    expect(outcome.operation.step).toBeNull();
    expect(harness.provisioning.deprovision).toHaveBeenCalledTimes(1);
  });

  it("refuses an idempotency key that was already used for a different request", async () => {
    const harness = await createAppsHarness();
    const installed = await harness.install();
    await harness.lifecycle.disable({
      workspaceId,
      installationId: installed.installation.id,
      expectedVersion: installed.installation.version,
      idempotencyKey: "shared-key",
      principal,
    });
    const disabled = await harness.repositories.installations.findById(workspaceId, installed.installation.id);

    await expect(harness.lifecycle.remove({
      workspaceId,
      installationId: installed.installation.id,
      expectedVersion: disabled!.version,
      idempotencyKey: "shared-key",
      disposition: "delete",
      principal,
    })).rejects.toMatchObject({ reason: "idempotency_key_reused" });
    // The App is still installed: nothing reported success for a removal that never ran.
    expect((await harness.repositories.installations.findById(workspaceId, installed.installation.id))!.state)
      .toBe("disabled");
  });

  it("replays the same operation for a retry that repeats the same request", async () => {
    const harness = await createAppsHarness();
    const installed = await harness.install();
    const first = await harness.lifecycle.disable({
      workspaceId,
      installationId: installed.installation.id,
      expectedVersion: installed.installation.version,
      idempotencyKey: "disable-retry",
      principal,
    });

    const retried = await harness.lifecycle.disable({
      workspaceId,
      installationId: installed.installation.id,
      expectedVersion: installed.installation.version,
      idempotencyKey: "disable-retry",
      principal,
    });

    expect(retried.operation.id).toBe(first.operation.id);
    expect(harness.provisioning.deprovision).toHaveBeenCalledTimes(1);
  });

  it("binds a lifecycle command to the installation version the operator read", async () => {
    const harness = await createAppsHarness();
    const installed = await harness.install();

    await expect(harness.lifecycle.disable({
      workspaceId,
      installationId: installed.installation.id,
      expectedVersion: installed.installation.version + 5,
      idempotencyKey: "disable-stale",
      principal,
    })).rejects.toMatchObject({ reason: "plan_stale", details: { cause: "version_mismatch" } });
  });
});

describe("app lifecycle recovery", () => {
  it("resumes from the durable cursor and never repeats a landed effect under a new id", async () => {
    for (const stepId of activateSteps) {
      const harness = await createAppsHarness();
      const { operation: crashed } = await crashDuringActivation(harness, stepId);

      const index = appSagaSteps.activate.findIndex((step) => step.id === stepId);
      expect(crashed.state).toBe("running");
      expect(crashed.step).toBe(appSagaSteps.activate[index - 1]?.id ?? null);

      const resumed = await harness.lifecycle.resumeById(workspaceId, crashed.id);

      expect(resumed.operation.state).toBe("completed");
      expect(resumed.installation.state).toBe("active");

      const ports = {
        provision_runtime: harness.provisioning.provision,
        stage_contributions: harness.staging.stage,
        run_safe_tests: harness.staging.runSafeTests,
      };
      // The interrupted step is attempted at most once more, and both attempts carry the
      // same effect id, so an implementation that deduplicates on it lands one effect.
      for (const [id, port] of Object.entries(ports)) {
        const attempts = port.mock.calls.length;
        expect(attempts).toBe(id === stepId ? 2 : 1);
      }
      const effects = ports[stepId].mock.calls.map((call) => call[0].effect);
      expect(effects[0]).toEqual(effects[1]);
      expect(effects[0]).toEqual({ operationId: crashed.id, stepId });
    }
  });

  it("sends a persisted compensating operation to the reverse runner, not forward", async () => {
    const harness = await createAppsHarness();
    const { operation: crashed } = await crashDuringActivation(harness, "stage_contributions");
    // The process died after compensation opened but before any compensator ran.
    await harness.repositories.operations.update(crashed.id, {
      state: "compensating",
      error: { reason: "internal", message: "abandoned" },
    });
    harness.staging.stage.mockClear();

    const resumed = await harness.lifecycle.resumeById(workspaceId, crashed.id);

    expect(resumed.operation.state).toBe("failed");
    expect(resumed.installation.state).toBe("failed");
    // The forward path was never re-entered: nothing was staged, tested, or activated on
    // an installation whose runtime was already being torn down.
    expect(harness.staging.stage).not.toHaveBeenCalled();
    expect(harness.provisioning.deprovision).toHaveBeenCalled();
  });

  it("continues an interrupted rollback from the compensation cursor", async () => {
    const harness = await createAppsHarness();
    const { operation: crashed } = await crashDuringActivation(harness, "stage_contributions");
    await harness.repositories.operations.update(crashed.id, {
      state: "compensating",
      error: { reason: "internal", message: "abandoned" },
      // `provision_runtime` was already reversed before the process died.
      compensationStep: "provision_runtime",
    });
    harness.provisioning.deprovision.mockClear();

    const resumed = await harness.lifecycle.resumeById(workspaceId, crashed.id);

    expect(resumed.operation.state).toBe("failed");
    expect(harness.provisioning.deprovision).not.toHaveBeenCalled();
  });

  it("marks an operation compensation_failed only after the cursor is persisted", async () => {
    const harness = await createAppsHarness();
    const { operation: crashed } = await crashDuringActivation(harness, "stage_contributions");
    await harness.repositories.operations.update(crashed.id, {
      state: "compensating",
      error: { reason: "runtime_unavailable", message: "the runtime refused" },
    });
    harness.provisioning.deprovision.mockResolvedValueOnce({ ok: false, code: "runtime_deprovision_failed" });

    const resumed = await harness.lifecycle.resumeById(workspaceId, crashed.id);

    expect(resumed.operation.state).toBe("compensation_failed");
    expect(resumed.operation.compensationStep).toBeNull();
    expect(resumed.operation.error?.message).toContain("an operator needs to review this installation");
    expect(resumed.installation.state).toBe("failed");
  });

  it("refuses to re-drive an operation that already failed and compensated", async () => {
    const harness = await createAppsHarness();
    const applied = await harness.apply();
    await harness.connections.bind({
      workspaceId,
      installationId: applied.installation.id,
      slotId: "webhook_secret",
      values: {},
      expectedVersion: applied.installation.version,
      principal,
    });
    const current = await harness.repositories.installations.findById(workspaceId, applied.installation.id);
    harness.staging.stage.mockResolvedValueOnce({ ok: false, code: "contribution_staging_failed" });

    const failed = await harness.lifecycle.activate({
      workspaceId,
      installationId: applied.installation.id,
      expectedVersion: current!.version,
      idempotencyKey: "activate-fail",
      principal,
    });

    expect(failed.operation.state).toBe("failed");
    expect(failed.installation.state).toBe("failed");
    expect(harness.provisioning.deprovision).toHaveBeenCalledTimes(1);

    const resumed = await harness.lifecycle.resumeById(workspaceId, failed.operation.id);

    expect(resumed.operation.state).toBe("failed");
    expect(harness.staging.stage).toHaveBeenCalledTimes(1);
    expect(harness.staging.runSafeTests).not.toHaveBeenCalled();
  });
});

describe("app lifecycle authority", () => {
  it("compensates when the initiating principal is explicitly denied", async () => {
    const harness = await createAppsHarness();
    const { operation: crashed } = await crashDuringActivation(harness, "stage_contributions");

    harness.authorization.allow = false;
    const resumed = await harness.lifecycle.resumeById(workspaceId, crashed.id);

    expect(resumed.operation.state).toBe("failed");
    expect(resumed.operation.error?.reason).toBe("initiating_principal_unauthorized");
    expect(harness.staging.stage).toHaveBeenCalledTimes(1);
  });

  it("pauses, rather than compensates, when authorization cannot be established", async () => {
    const harness = await createAppsHarness();
    const { operation: crashed } = await crashDuringActivation(harness, "stage_contributions");

    harness.authorization.indeterminate = true;
    await expect(harness.lifecycle.resumeById(workspaceId, crashed.id))
      .rejects.toMatchObject({ reason: "authorization_unavailable" });

    // The operation is still exactly where it was: no compensator ran, no new effect
    // landed, and the installation was not failed on the strength of a lookup that never
    // answered.
    const held = await harness.repositories.operations.findById(crashed.id);
    expect(held?.state).toBe("running");
    expect(held?.step).toBe(crashed.step);
    expect(harness.provisioning.deprovision).not.toHaveBeenCalled();
    expect(harness.staging.stage).toHaveBeenCalledTimes(1);

    // And it resumes once the answer comes back.
    harness.authorization.indeterminate = false;
    const resumed = await harness.lifecycle.resumeById(workspaceId, crashed.id);
    expect(resumed.installation.state).toBe("active");
  });

  it("re-checks the current principal on every mutation", async () => {
    const harness = await createAppsHarness();
    const installed = await harness.install();
    harness.authorization.allow = false;

    await expect(harness.lifecycle.disable({
      workspaceId,
      installationId: installed.installation.id,
      expectedVersion: installed.installation.version,
      idempotencyKey: "disable-denied",
      principal,
    })).rejects.toMatchObject({ reason: "initiating_principal_unauthorized" });
    await expect(harness.plans.create({
      workspaceId,
      releaseId: installed.installation.activeReleaseId!,
      configuration: {},
      principal,
    })).rejects.toThrow();
    await expect(harness.connections.bind({
      workspaceId,
      installationId: installed.installation.id,
      slotId: "webhook_secret",
      values: {},
      expectedVersion: installed.installation.version,
      principal,
    })).rejects.toThrow();
    await expect(harness.lifecycle.reconfigure({
      workspaceId,
      installationId: installed.installation.id,
      configuration: { site_url: "https://example.com" },
      expectedVersion: installed.installation.version,
      idempotencyKey: "reconfigure-denied",
      principal,
    })).rejects.toThrow();
  });

  // FR-027a names plan inspection alongside approval: what an operator is shown here is
  // what apply binds to, so reading it back is a protected read rather than a free one.
  it("re-checks the current principal when a plan is read back", async () => {
    const harness = await createAppsHarness();
    const releaseId = await harness.admitReference();
    const created = await harness.plans.create({
      workspaceId, releaseId, configuration: { site_url: "https://example.com" }, principal,
    });

    await expect(harness.plans.get(workspaceId, created.id, principal)).resolves.toMatchObject({ id: created.id });

    harness.authorization.allow = false;
    await expect(harness.plans.get(workspaceId, created.id, principal)).rejects.toThrow();
  });
});

describe("app installation removal", () => {
  it("disables, re-enables, and removes an installation", async () => {
    const harness = await createAppsHarness();
    const installed = await harness.install();
    const installationId = installed.installation.id;

    const disabled = await harness.lifecycle.disable({
      workspaceId, installationId, expectedVersion: installed.installation.version, idempotencyKey: "disable-1", principal,
    });
    expect(disabled.installation.state).toBe("disabled");
    expect(harness.provisioning.deprovision).toHaveBeenCalledTimes(1);

    const enabled = await harness.lifecycle.enable({
      workspaceId, installationId, expectedVersion: disabled.installation.version, idempotencyKey: "enable-1", principal,
    });
    expect(enabled.installation.state).toBe("active");

    const removed = await harness.lifecycle.remove({
      workspaceId,
      installationId,
      expectedVersion: enabled.installation.version,
      idempotencyKey: "remove-1",
      principal,
      disposition: "delete",
    });
    expect(removed.installation.state).toBe("removed");
    expect(await harness.repositories.grants.listLive(installationId)).toEqual([]);
    expect(recordedEvents(harness.audit)).toContain("app.grant.revoked");
    expect(recordedEvents(harness.audit)).toContain("app.installation.removed");
  });

  it("emits a connection revocation event with a count when credentials are marked for deletion", async () => {
    const harness = await createAppsHarness();
    const installed = await harness.install();

    await harness.lifecycle.remove({
      workspaceId,
      installationId: installed.installation.id,
      expectedVersion: installed.installation.version,
      idempotencyKey: "remove-2",
      principal,
      disposition: "export",
    });

    const revocation = harness.audit.record.mock.calls
      .map((call) => call[0] as { eventType: string; metadata: Record<string, unknown> })
      .find((event) => event.eventType === "app.connection.revoked");
    expect(revocation?.metadata).toMatchObject({ connectionCount: 1, actorUserId: principal.userId });

    const connections = await harness.repositories.connections.listByInstallation(installed.installation.id);
    expect(connections[0].deletionRequestedAt).not.toBeNull();
  });

  it("refuses a connection bind against an installation that is being removed", async () => {
    const harness = await createAppsHarness();
    const installed = await harness.install();
    const removed = await harness.lifecycle.remove({
      workspaceId,
      installationId: installed.installation.id,
      expectedVersion: installed.installation.version,
      idempotencyKey: "remove-3",
      principal,
      disposition: "delete",
    });

    await expect(harness.connections.bind({
      workspaceId,
      installationId: installed.installation.id,
      slotId: "webhook_secret",
      values: {},
      expectedVersion: removed.installation.version,
      principal,
    })).rejects.toMatchObject({ reason: "installation_removing" });

    // The credentials stay marked for deletion; a late bind cannot un-delete them.
    const connections = await harness.repositories.connections.listByInstallation(installed.installation.id);
    expect(connections[0].deletionRequestedAt).not.toBeNull();
  });
});

describe("app installation reconfiguration", () => {
  it("keeps an active configuration when staging a candidate fails", async () => {
    const harness = await createAppsHarness();
    const installed = await harness.install();
    const original = installed.installation.configuration;
    harness.staging.stage.mockResolvedValueOnce({ ok: false, code: "contribution_staging_failed" });

    const outcome = await harness.lifecycle.reconfigure({
      workspaceId,
      installationId: installed.installation.id,
      configuration: { ...original, poll_interval_sec: 60 },
      expectedVersion: installed.installation.version,
      idempotencyKey: "reconfigure-candidate-failure",
      principal,
    });

    expect(outcome.operation.state).toBe("failed");
    expect(outcome.installation.state).toBe("active");
    expect(outcome.installation.configuration).toEqual(original);
    expect(outcome.installation.candidateConfiguration).toBeNull();
  });

  it("re-stages and re-tests before a configuration change applies", async () => {
    const harness = await createAppsHarness();
    const installed = await harness.install();
    await harness.connections.bind({
      workspaceId,
      installationId: installed.installation.id,
      slotId: "site_credentials",
      values: { wp_username: "editor", wp_application_password: "hunter2" },
      expectedVersion: installed.installation.version,
      principal,
    });
    const current = await harness.repositories.installations.findById(workspaceId, installed.installation.id);
    harness.staging.stage.mockClear();
    harness.staging.runSafeTests.mockClear();

    const outcome = await harness.lifecycle.reconfigure({
      workspaceId,
      installationId: installed.installation.id,
      configuration: { site_url: "https://example.com", poll_interval_sec: 900 },
      expectedVersion: current!.version,
      idempotencyKey: "reconfigure-1",
      principal,
    });

    expect(outcome.operation.kind).toBe("reconfigure");
    expect(outcome.operation.state).toBe("completed");
    expect(outcome.installation.configuration.poll_interval_sec).toBe(900);
    expect(harness.staging.stage).toHaveBeenCalledTimes(1);
    expect(harness.staging.runSafeTests).toHaveBeenCalledTimes(1);
    // The re-staged projection is the one the new configuration turns on.
    expect(harness.staging.stage.mock.calls[0][0].contributions.map((contribution) => contribution.id))
      .toContain("content_poll");
  });

  it("refuses a configuration change that turns on a contribution whose connection is unbound", async () => {
    const harness = await createAppsHarness();
    const installed = await harness.install();
    harness.staging.stage.mockClear();

    const refused = await harness.lifecycle.reconfigure({
      workspaceId,
      installationId: installed.installation.id,
      configuration: { site_url: "https://example.com", poll_interval_sec: 900 },
      expectedVersion: installed.installation.version,
      idempotencyKey: "reconfigure-unbound",
      principal,
    });

    expect(refused.operation.state).toBe("failed");
    expect(refused.operation.error?.reason).toBe("connection_unbound");
    // Validation happens before anything is staged, so nothing was projected.
    expect(harness.staging.stage).not.toHaveBeenCalled();
  });

  it("refuses a configuration update that drops a required field", async () => {
    const harness = await createAppsHarness();
    const installed = await harness.install();

    const refused = await harness.lifecycle.reconfigure({
      workspaceId,
      installationId: installed.installation.id,
      configuration: { poll_interval_sec: 300 },
      expectedVersion: installed.installation.version,
      idempotencyKey: "reconfigure-invalid",
      principal,
    });

    expect(refused.operation.error?.reason).toBe("invalid_configuration");
  });

  it("refuses a connection bind while a lifecycle operation is in flight", async () => {
    const harness = await createAppsHarness();
    const installed = await harness.install();
    await harness.repositories.operations.start({
      installationId: installed.installation.id,
      kind: "reconfigure",
      idempotencyKey: "reconfigure-inflight",
      requestFingerprint: "fingerprint-c",
      initiatedBy: principal,
      payload: {},
    });

    await expect(harness.connections.bind({
      workspaceId,
      installationId: installed.installation.id,
      slotId: "site_credentials",
      values: { wp_username: "editor", wp_application_password: "hunter2" },
      expectedVersion: installed.installation.version,
      principal,
    })).rejects.toMatchObject({ reason: "operation_in_progress" });
  });
});

describe("app connections through the service", () => {
  it("mints a generated secret once, stores it encrypted, and never reads it back", async () => {
    const harness = await createAppsHarness();
    const applied = await harness.apply();

    const bound = await harness.connections.bind({
      workspaceId,
      installationId: applied.installation.id,
      slotId: "webhook_secret",
      values: {},
      expectedVersion: applied.installation.version,
      principal,
    });

    expect(bound.generatedSecret).toBeTruthy();
    expect(bound.connection.hasSecret).toBe(true);
    const stored = harness.repositories.connections.rows[0];
    expect(stored.secretCiphertext).toBe(`enc(${bound.generatedSecret})`);

    const listed = await harness.connections.list(applied.installation.id);
    expect(JSON.stringify(listed)).not.toContain(bound.generatedSecret!);

    const view = await harness.installations.get(workspaceId, applied.installation.id);
    expect(JSON.stringify(view)).not.toContain(bound.generatedSecret!);
    expect(JSON.stringify(auditMetadata(harness.audit))).not.toContain(bound.generatedSecret!);
  });

  it("keeps a sensitive field out of every readable surface", async () => {
    const harness = await createAppsHarness();
    const applied = await harness.apply();

    const bound = await harness.connections.bind({
      workspaceId,
      installationId: applied.installation.id,
      slotId: "site_credentials",
      values: { wp_username: "editor", wp_application_password: "hunter2" },
      expectedVersion: applied.installation.version,
      principal,
    });

    expect(bound.generatedSecret).toBeNull();
    expect(bound.connection.publicFields).toEqual({ wp_username: "editor" });
    expect(JSON.stringify(bound)).not.toContain("hunter2");
    expect(JSON.stringify(auditMetadata(harness.audit))).not.toContain("hunter2");
  });

  it("refuses a slot the release does not declare", async () => {
    const harness = await createAppsHarness();
    const applied = await harness.apply();

    await expect(harness.connections.bind({
      workspaceId,
      installationId: applied.installation.id,
      slotId: "nonexistent",
      values: {},
      expectedVersion: applied.installation.version,
      principal,
    })).rejects.toMatchObject({ reason: "connection_slot_unknown" });
  });

  it("binds a connection to the installation version the operator read", async () => {
    const harness = await createAppsHarness();
    const applied = await harness.apply();

    await expect(harness.connections.bind({
      workspaceId,
      installationId: applied.installation.id,
      slotId: "webhook_secret",
      values: {},
      expectedVersion: applied.installation.version + 3,
      principal,
    })).rejects.toMatchObject({ reason: "plan_stale", details: { cause: "version_mismatch" } });
  });
});
