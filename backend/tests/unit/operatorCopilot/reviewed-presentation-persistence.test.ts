import { describe, expect, it, vi } from "vitest";

import { splitStoredReview } from "../../../src/modules/operatorCopilot/reviewedOperation.js";
import { persistReviewedPreparation, type ReviewedPreparationDependencies } from "../../../src/modules/operatorCopilot/tools/reviewedPreparation.js";

const agentId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const effect = { exposure: "live" as const, reversibility: "reversible" as const, metered: false };

const prepare = async (declared: Parameters<typeof persistReviewedPreparation>[0]["affectedAgents"], extra: { summary?: string; reach?: boolean } = {}) => {
  const createProposal = vi.fn(async (draft: { reviewSnapshot: unknown }) => ({ id: "proposal-1", targetType: "agent_setting", ...draft }));
  const deps = {
    proposalRepository: { createProposal },
    auditService: { record: vi.fn(async () => {}) },
    proposalAdapters: {},
    proposalRecovery: {},
    agentLookup: { listExisting: async () => Array.from({ length: 40 }, (_, index) => ({ id: agentId(index), name: `Agent ${index}`, isDefault: false, assistantBootstrapActive: false })) },
  } as unknown as ReviewedPreparationDependencies;
  await persistReviewedPreparation({
    deps,
    context: { workspaceId: "workspace-1", accountId: "account-1", operatorUserId: "user-1", operatorMcpInvocationId: "invocation-1" } as never,
    targetType: "agent_setting", targetRef: {}, payload: {}, versionToken: "v1", reviewSnapshot: { changes: [] }, operation: "test", effect,
    affectedAgents: declared, ...extra,
  });
  return splitStoredReview(createProposal.mock.calls[0][0].reviewSnapshot);
};

describe("reviewed preparation presentation", () => {
  it("stores the agents a preparation declares, naming those it gave only by id", async () => {
    const stored = await prepare({ agents: [{ id: agentId(1) }, { id: agentId(2), name: "Sales" }] }, { summary: "Tighten replies", reach: true });
    expect(stored.review).toEqual({ changes: [] });
    expect(stored.presentation).toEqual({
      summary: "Tighten replies",
      reach: true,
      affectedAgents: { agents: [{ id: agentId(1), name: "Agent 1" }, { id: agentId(2), name: "Sales" }], truncated: false },
    });
  });

  it("keeps the declared truncation and marks a list it had to cut", async () => {
    const declaredTruncated = await prepare({ agents: [{ id: agentId(1) }], truncated: true });
    expect(declaredTruncated.presentation?.affectedAgents.truncated).toBe(true);
    const tooMany = await prepare({ agents: Array.from({ length: 30 }, (_, index) => ({ id: agentId(index) })) });
    expect(tooMany.presentation?.affectedAgents.agents).toHaveLength(25);
    expect(tooMany.presentation?.affectedAgents.truncated).toBe(true);
  });

  it("records a workspace-level change as reaching no named agent", async () => {
    expect((await prepare({ agents: [] })).presentation?.affectedAgents).toEqual({ agents: [], truncated: false });
  });
});
