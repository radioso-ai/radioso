import { describe, expect, it } from "vitest";

import {
  APPS_TEST_PRINCIPAL as principal,
  APPS_TEST_WORKSPACE_ID as workspaceId,
  createAppsHarness,
  type AppsHarness,
} from "./support.js";

const readyToActivate = async (harness: AppsHarness, key = "install-1") => {
  const applied = await harness.apply({ idempotencyKey: key });
  await harness.connections.bind({
    workspaceId,
    installationId: applied.installation.id,
    slotId: "webhook_secret",
    values: {},
    expectedVersion: applied.installation.version,
    idempotencyKey: `${key}-bind`,
    principal,
  });
  const current = await harness.repositories.installations.findById(workspaceId, applied.installation.id);
  return { installationId: applied.installation.id, version: current!.version };
};

describe("app activation is retryable after a transient provider failure", () => {
  it("activates on the second attempt once the provider recovers", async () => {
    const harness = await createAppsHarness();
    const { installationId, version } = await readyToActivate(harness);
    harness.provisioning.provision.mockResolvedValueOnce({ ok: false, code: "runtime_provision_failed" });

    const failed = await harness.lifecycle.activate({
      workspaceId,
      installationId,
      expectedVersion: version,
      idempotencyKey: "activate-attempt-1",
      principal,
    });

    expect(failed.operation.state).toBe("failed");
    // The attempt is what failed, not the installation. `activate` is only issuable from
    // `planned`, so anything else here would make one outage permanent.
    expect(failed.installation.state).toBe("planned");
    expect(failed.installation.health).toMatchObject({ reason: "runtime_unavailable" });

    const retried = await harness.lifecycle.activate({
      workspaceId,
      installationId,
      expectedVersion: failed.installation.version,
      idempotencyKey: "activate-attempt-2",
      principal,
    });

    expect(retried.operation.state).toBe("completed");
    expect(retried.installation.state).toBe("active");
  });
});

describe("app installation repair", () => {
  it("resumes the failed operation's own compensator rather than starting a new one", async () => {
    const harness = await createAppsHarness();
    const { installationId, version } = await readyToActivate(harness);
    // Staging fails, then the deprovision that would roll it back fails too, so the
    // rollback stops with `provision_runtime` still owed.
    harness.staging.stage.mockResolvedValueOnce({ ok: false, code: "contribution_staging_failed" });
    harness.provisioning.deprovision.mockResolvedValueOnce({ ok: false, code: "runtime_deprovision_failed" });

    const stopped = await harness.lifecycle.activate({
      workspaceId,
      installationId,
      expectedVersion: version,
      idempotencyKey: "activate-stuck",
      principal,
    });
    expect(stopped.operation.state).toBe("compensation_failed");
    const stuckOperationId = stopped.operation.id;

    harness.provisioning.deprovision.mockClear();
    const removed = await harness.lifecycle.remove({
      workspaceId,
      installationId,
      disposition: "delete",
      expectedVersion: stopped.installation.version,
      idempotencyKey: "repair-remove",
      principal,
    });

    // The compensator that was owed ran under the identity of the operation that owed it,
    // so the provider recognises the runtime it is being asked to stop.
    const repairEffects = harness.provisioning.deprovision.mock.calls.map((call) => call[0].effect);
    expect(repairEffects[0]).toEqual({
      operationId: stuckOperationId,
      stepId: "compensate:provision_runtime",
    });
    // Only then did the removal proceed, under its own identity.
    expect(repairEffects.at(-1)?.operationId).toBe(removed.operation.id);
    expect(removed.installation.state).toBe("removed");
    const repaired = await harness.repositories.operations.findById(stuckOperationId);
    expect(repaired!.state).toBe("failed");
  });

  it("refuses a command other than removal while a rollback is unfinished", async () => {
    const harness = await createAppsHarness();
    const { installationId, version } = await readyToActivate(harness);
    harness.staging.stage.mockResolvedValueOnce({ ok: false, code: "contribution_staging_failed" });
    harness.provisioning.deprovision.mockResolvedValueOnce({ ok: false, code: "runtime_deprovision_failed" });
    const stopped = await harness.lifecycle.activate({
      workspaceId,
      installationId,
      expectedVersion: version,
      idempotencyKey: "activate-stuck-2",
      principal,
    });

    await expect(harness.lifecycle.activate({
      workspaceId,
      installationId,
      expectedVersion: stopped.installation.version,
      idempotencyKey: "activate-again",
      principal,
    })).rejects.toMatchObject({ reason: "operation_in_progress" });
  });
});

describe("app lifecycle recovery sweep", () => {
  /**
   * A driver that dies between a landed external effect and the cursor that records it.
   * The operation stays running, at the cursor it had, with a claim nobody renews.
   */
  const crashAfterProvisioning = async (harness: AppsHarness, key: string) => {
    const { installationId, version } = await readyToActivate(harness, key);
    const advance = harness.repositories.operations.advance.bind(harness.repositories.operations);
    let crashed = false;
    harness.repositories.operations.advance = async (id, input) => {
      if (!crashed) {
        crashed = true;
        throw new Error("the driver's process died");
      }
      return advance(id, input);
    };

    await expect(harness.lifecycle.activate({
      workspaceId,
      installationId,
      expectedVersion: version,
      idempotencyKey: `${key}-activate`,
      principal,
    })).rejects.toThrow();

    const operation = (await harness.repositories.operations.listByInstallation(installationId, 10))
      .find((row) => row.kind === "activate");
    expect(operation!.state).toBe("running");
    expect(operation!.step).toBeNull();
    return { installationId, operation: operation! };
  };

  it("re-drives an operation whose driver died holding it", async () => {
    const harness = await createAppsHarness();
    const { installationId, operation } = await crashAfterProvisioning(harness, "crash");
    // The claim the dead driver left behind has lapsed.
    harness.repositories.operations.rows.set(operation.id, {
      ...operation,
      leaseExpiresAt: new Date(Date.now() - 1_000),
    });

    const resumed = await harness.lifecycle.recoverStalledOperations();

    expect(resumed).toBe(1);
    const installation = await harness.repositories.installations.findById(workspaceId, installationId);
    expect(installation!.state).toBe("active");
    // The runtime was provisioned twice under the same effect id, which is what every
    // implementation deduplicates on — never twice under two different ones.
    const effects = harness.provisioning.provision.mock.calls.map((call) => call[0].effect);
    expect(new Set(effects.map((effect) => JSON.stringify(effect))).size).toBe(1);
  });

  it("leaves an operation a live driver still holds alone", async () => {
    const harness = await createAppsHarness();
    const { operation } = await crashAfterProvisioning(harness, "held");
    harness.repositories.operations.rows.set(operation.id, {
      ...operation,
      leaseOwner: "a-driver-that-is-alive",
      leaseExpiresAt: new Date(Date.now() + 300_000),
    });

    await expect(harness.lifecycle.recoverStalledOperations()).resolves.toBe(0);
  });
});

describe("app reconfiguration promotes the candidate it staged", () => {
  it("promotes through the port and moves the live revision in the same commit", async () => {
    const harness = await createAppsHarness();
    const active = await harness.install();

    const reconfigured = await harness.lifecycle.reconfigure({
      workspaceId,
      installationId: active.installation.id,
      configuration: { site_url: "https://moved.example.com" },
      expectedVersion: active.installation.version,
      idempotencyKey: "reconfigure-promote",
      principal,
    });

    expect(reconfigured.operation.state).toBe("completed");
    const promoted = harness.staging.promote.mock.calls[0]?.[0];
    expect(promoted).toMatchObject({
      installationId: active.installation.id,
      candidateRevision: reconfigured.operation.id,
    });
    expect(reconfigured.installation.activeRevision).toBe(reconfigured.operation.id);
    expect(reconfigured.installation.candidateRevision).toBeNull();
    expect(reconfigured.installation.configuration).toMatchObject({ site_url: "https://moved.example.com" });
  });

  it("returns the installation the compensator actually left behind", async () => {
    const harness = await createAppsHarness();
    const active = await harness.install();
    harness.staging.runSafeTests.mockResolvedValueOnce({ ok: false, code: "safe_test_failed" });

    const refused = await harness.lifecycle.reconfigure({
      workspaceId,
      installationId: active.installation.id,
      configuration: { site_url: "https://rejected.example.com" },
      expectedVersion: active.installation.version,
      idempotencyKey: "reconfigure-rejected",
      principal,
    });

    expect(refused.operation.state).toBe("failed");
    // The candidate was discarded, and the record handed back says so rather than being
    // the pre-clear copy the runner started with.
    expect(refused.installation.candidateConfiguration).toBeNull();
    expect(refused.installation.candidateRevision).toBeNull();
    expect(refused.installation.state).toBe("active");
    expect(refused.installation.configuration).toMatchObject({ site_url: "https://example.com" });
    expect(harness.staging.promote).not.toHaveBeenCalled();
  });
});
