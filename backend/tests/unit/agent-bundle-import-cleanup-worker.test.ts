import { describe, expect, it, vi } from "vitest";

import { AgentBundleImportCleanupWorker } from "../../src/modules/agentBundle/public.js";

describe("AgentBundleImportCleanupWorker", () => {
  it("leases stale applying imports, deletes their agent, records compensation, and increments the ops counter", async () => {
    const imports = {
      claimStaleApplying: vi.fn(async () => [{
        id: "import-1", workspaceId: "workspace-1", actorAccountId: "account-1", agentId: "agent-1",
      }]),
      markCompensated: vi.fn(async () => undefined),
    };
    const deleteAgent = vi.fn(async () => undefined);
    const record = vi.fn(async () => undefined);
    const incrementCounter = vi.fn();
    const worker = new AgentBundleImportCleanupWorker({
      imports: imports as never,
      agents: { create: async () => ({ agentId: "unused" }), delete: deleteAgent },
      audit: { record },
      logger: { info: vi.fn(), error: vi.fn() },
      metrics: { incrementCounter },
      orphanAgeMs: 60_000,
      cleanupLeaseMs: 30_000,
    });

    await expect(worker.sweep()).resolves.toEqual({ status: "swept", compensated: 1, failed: 0 });
    expect(imports.claimStaleApplying).toHaveBeenCalledWith(expect.objectContaining({
      ageSeconds: 60,
      leaseSeconds: 30,
      limit: 20,
      leaseToken: expect.any(String),
    }));
    expect(deleteAgent).toHaveBeenCalledWith("workspace-1", "agent-1");
    expect(imports.markCompensated).toHaveBeenCalledWith("import-1", expect.any(String));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "agent.bundle.import.compensated",
      metadata: expect.objectContaining({ importId: "import-1", agentId: "agent-1", principalType: "system" }),
    }));
    expect(incrementCounter).toHaveBeenCalledWith("agent_bundle_import_compensations_total", expect.objectContaining({
      labels: { outcome: "compensated" },
    }));
  });
});
