import { describe, expect, it, vi } from "vitest";

import { createAgentToolCatalogComposition } from "../../../src/app/composition/agentToolCatalog.js";

const composition = (publicDescription: string) => createAgentToolCatalogComposition({
  agentRepository: {
    findByIdAndWorkspaceId: vi.fn(async () => ({ id: "agent-1", name: "Acme Support", publicDescription })),
  },
  agentRevisionReader: {
    findCurrentPublished: vi.fn(async () => ({ snapshot: { routines: [] } })),
    findRevision: vi.fn(),
  },
} as never);

describe("agent tool catalog composition", () => {
  it("carries the operator-authored public description into the composed ask_agent description", async () => {
    // FR-052 names the operator description as an input. Wiring that returns null for it leaves the
    // clause unreachable in production while the unit test, which passes one directly, still passes.
    const catalog = await composition("orders, returns, billing").load({ workspaceId: "ws-1", agentId: "agent-1" });

    expect(catalog.agent.description).toBe("orders, returns, billing");
    expect(catalog.askAgentDescription).toContain("orders, returns, billing");
  });

  it("treats an unset description as absent rather than as a description of nothing", async () => {
    const catalog = await composition("   ").load({ workspaceId: "ws-1", agentId: "agent-1" });

    expect(catalog.agent.description).toBeNull();
    expect(catalog.askAgentDescription).not.toContain("It covers");
  });
});
