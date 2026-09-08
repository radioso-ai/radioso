import { describe, expect, it } from "vitest";

import { parseAppPortResult } from "../../../src/modules/apps/domain/portOutcome.js";
import {
  APPS_TEST_PRINCIPAL as principal,
  APPS_TEST_WORKSPACE_ID as workspaceId,
  createAppsHarness,
  immediateLeaseTimer,
} from "./support.js";

/**
 * A lease is only a serialization device if it outlives nothing. These cover the two ways
 * a driver can stop being entitled to the result it is holding, and the way an adapter can
 * answer with something this platform did not define.
 */
describe("app lifecycle step leases", () => {
  it("discards a port result whose claim lapsed while the call was in flight", async () => {
    const harness = await createAppsHarness({ leaseTimer: immediateLeaseTimer() });
    const applied = await harness.apply();
    await harness.connections.bind({
      workspaceId,
      installationId: applied.installation.id,
      slotId: "webhook_secret",
      values: {},
      expectedVersion: applied.installation.version,
      idempotencyKey: "bind-lease",
      principal,
    });
    const current = await harness.repositories.installations.findById(workspaceId, applied.installation.id);

    // The provider is slow, and while it is working a second driver takes the operation
    // over: the claim this driver made no longer names it.
    let releaseProvider: () => void = () => {};
    const provided = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    harness.provisioning.provision.mockImplementationOnce(async () => {
      const [operation] = [...harness.repositories.operations.rows.values()]
        .filter((row) => row.state === "running");
      harness.repositories.operations.rows.set(operation.id, {
        ...operation,
        leaseOwner: "another-driver",
        leaseExpiresAt: new Date(Date.now() + 300_000),
      });
      await provided;
      return { ok: true as const };
    });

    const outcome = harness.lifecycle.activate({
      workspaceId,
      installationId: applied.installation.id,
      expectedVersion: current!.version,
      idempotencyKey: "activate-lease-lost",
      principal,
    });
    // The provider answers eventually; by then this driver has already let go.
    setTimeout(releaseProvider, 0);
    const result = await outcome;

    // Nothing was written on the strength of a result this driver was no longer entitled
    // to: the installation never entered `provisioning` and the cursor never moved.
    expect(result.installation.state).toBe("planned");
    expect(result.operation.state).toBe("running");
    expect(result.operation.step).toBeNull();
    const stored = await harness.repositories.installations.findById(workspaceId, applied.installation.id);
    expect(stored!.state).toBe("planned");
    expect(harness.staging.stage).not.toHaveBeenCalled();
    expect(JSON.stringify(harness.logs)).toContain("no longer holds the operation");
  });
});

describe("app port outcome validation", () => {
  it.each([
    ["a missing discriminator", {}],
    ["a code this platform never defined", { ok: false, code: "please-log-this-token" }],
    ["a value that is not an object at all", "ok"],
    ["nothing", null],
  ])("normalizes %s to the closed protocol-violation code", (_case, value) => {
    expect(parseAppPortResult(value)).toEqual({ ok: false, code: "adapter_protocol_violation" });
  });

  it("keeps an adapter's invented code out of the operation and the logs", async () => {
    const harness = await createAppsHarness();
    const applied = await harness.apply();
    await harness.connections.bind({
      workspaceId,
      installationId: applied.installation.id,
      slotId: "webhook_secret",
      values: {},
      expectedVersion: applied.installation.version,
      idempotencyKey: "bind-protocol",
      principal,
    });
    const current = await harness.repositories.installations.findById(workspaceId, applied.installation.id);
    const invented = "code-from-outside-carrying-a-token";
    harness.provisioning.provision.mockResolvedValueOnce(
      { ok: false, code: invented } as unknown as { ok: true },
    );

    const outcome = await harness.lifecycle.activate({
      workspaceId,
      installationId: applied.installation.id,
      expectedVersion: current!.version,
      idempotencyKey: "activate-protocol-violation",
      principal,
    });

    expect(outcome.operation.state).toBe("failed");
    expect(outcome.operation.error?.message).toContain("cannot read as a result");
    expect(JSON.stringify(outcome)).not.toContain(invented);
    expect(JSON.stringify(harness.logs)).not.toContain(invented);
    expect(JSON.stringify(harness.logs)).toContain("adapter_protocol_violation");
  });
});
