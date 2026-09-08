import { describe, expect, it } from "vitest";

import {
  APPS_TEST_PRINCIPAL as principal,
  APPS_TEST_WORKSPACE_ID as workspaceId,
  auditMetadata,
  createAppsHarness,
} from "./support.js";

/**
 * A runtime, staging, or disposition adapter talks to a container API, a broker, or an
 * external service, and any of those can put a bearer token, a connection string, or a
 * response body into an exception message. This sentinel stands in for that value: it
 * must not appear in installation health, in the operation's error, in an audit record,
 * or in a log line, because all four are read by operators and some are stored.
 */
const SENTINEL = "sk-live-DO-NOT-DISCLOSE-1234567890";

describe("secret-safe diagnostics", () => {
  it("keeps an adapter's exception text out of every persisted and presented surface", async () => {
    const harness = await createAppsHarness();
    const applied = await harness.apply();
    await harness.connections.bind({
      workspaceId,
      installationId: applied.installation.id,
      slotId: "webhook_secret",
      values: {},
      expectedVersion: applied.installation.version,
      idempotencyKey: "bind-11",
      principal,
    });
    const current = await harness.repositories.installations.findById(workspaceId, applied.installation.id);
    harness.provisioning.provision.mockImplementationOnce(() => {
      throw new Error(`the sandbox rejected the request with credentials ${SENTINEL}`);
    });

    const outcome = await harness.lifecycle.activate({
      workspaceId,
      installationId: applied.installation.id,
      expectedVersion: current!.version,
      idempotencyKey: "activate-sentinel",
      principal,
    });

    expect(outcome.operation.state).toBe("failed");
    expect(outcome.installation.state).toBe("planned");
    // The failure is still legible: a reason code and a message written in this repository.
    expect(outcome.operation.error?.message).toContain("App platform adapter failed");
    expect(outcome.installation.health).toMatchObject({ reason: "runtime_unavailable" });

    expect(JSON.stringify(outcome)).not.toContain(SENTINEL);
    expect(JSON.stringify(auditMetadata(harness.audit))).not.toContain(SENTINEL);
    expect(JSON.stringify([...harness.repositories.operations.rows.values()])).not.toContain(SENTINEL);
    expect(JSON.stringify([...harness.repositories.installations.rows.values()])).not.toContain(SENTINEL);
    expect(JSON.stringify(harness.logs)).not.toContain(SENTINEL);
    // What the logs do carry is the identity of the failure, so it stays debuggable.
    expect(JSON.stringify(harness.logs)).toContain("adapter threw instead of reporting a typed result");
  });

  it("records a port's typed refusal as a code and a static message", async () => {
    const harness = await createAppsHarness();
    const applied = await harness.apply();
    await harness.connections.bind({
      workspaceId,
      installationId: applied.installation.id,
      slotId: "webhook_secret",
      values: {},
      expectedVersion: applied.installation.version,
      idempotencyKey: "bind-12",
      principal,
    });
    const current = await harness.repositories.installations.findById(workspaceId, applied.installation.id);
    harness.provisioning.provision.mockResolvedValueOnce({ ok: false, code: "runtime_unavailable" });

    const outcome = await harness.lifecycle.activate({
      workspaceId,
      installationId: applied.installation.id,
      expectedVersion: current!.version,
      idempotencyKey: "activate-refused",
      principal,
    });

    expect(outcome.operation.error).toEqual({
      reason: "runtime_unavailable",
      message: "No App runtime provider is configured, so this installation cannot run. Configure a runtime provider and retry.",
    });
  });

  it("does not let an audit sink failure change what the lifecycle decided", async () => {
    const harness = await createAppsHarness();
    const applied = await harness.apply();
    await harness.connections.bind({
      workspaceId,
      installationId: applied.installation.id,
      slotId: "webhook_secret",
      values: {},
      expectedVersion: applied.installation.version,
      idempotencyKey: "bind-13",
      principal,
    });
    const current = await harness.repositories.installations.findById(workspaceId, applied.installation.id);
    harness.audit.record.mockImplementation(async () => {
      throw new Error(`the audit sink is unavailable: ${SENTINEL}`);
    });

    const installed = await harness.lifecycle.activate({
      workspaceId,
      installationId: applied.installation.id,
      expectedVersion: current!.version,
      idempotencyKey: "activate-audit-down",
      principal,
    });

    // Activation happened and is recorded as such: an unavailable sink is not a reason to
    // tear down a runtime that is already serving.
    expect(installed.installation.state).toBe("active");
    expect(installed.operation.state).toBe("completed");
    expect(JSON.stringify(harness.logs)).toContain("App audit event could not be delivered yet");
    expect(JSON.stringify(harness.logs)).not.toContain(SENTINEL);
  });
});
