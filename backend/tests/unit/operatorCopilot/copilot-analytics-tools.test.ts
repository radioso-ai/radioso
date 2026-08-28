import { describe, expect, it, vi } from "vitest";

import { createAudiencePulseCopilotTools } from "../../../src/modules/operatorCopilot/tools/audiencePulse.js";
import { createEvalCopilotTools } from "../../../src/modules/operatorCopilot/tools/eval.js";
import { createQualityCopilotTools } from "../../../src/modules/operatorCopilot/tools/quality.js";
import type { CopilotEvalCaseSummary } from "../../../src/modules/operatorCopilot/contracts/evalCases.js";
import type { CopilotQualityTurn } from "../../../src/modules/operatorCopilot/tools/quality.js";

const qualityTurn: CopilotQualityTurn = {
  assistantMessageId: "message-1",
  conversationId: "conversation-1",
  agentId: "agent-1",
  agentName: "Support",
  question: "Where is my order?",
  answerPreview: "I could not find it.",
  createdAt: "2026-08-20T09:00:00.000Z",
  feedback: { downCount: 1, latestDownUpdatedAt: "2026-08-20T09:05:00.000Z", comments: [] },
};

const context = {
  workspaceId: "workspace-1",
  accountId: "account-1",
  operatorUserId: "operator-1",
  currentAuthorization: { hasAllPermissions: vi.fn(async () => true) },
  pageContext: { view: "evals" as const, agentId: "agent-1", conversationId: null, selection: null, entities: [] },
};

describe("copilot analytics readers", () => {
  it("provides bounded eval, quality, and stored audience readers with their required permissions", async () => {
    // The extra field is deliberate: the reader passes the whole eval row through, so the payload
    // bound has to hold for fields the port does not name.
    const listWithLatestRun = vi.fn(async (): Promise<ReadonlyArray<CopilotEvalCaseSummary>> => [{
      id: "case-1",
      name: "Checkout",
      status: "failing",
      updatedAt: "2026-08-20T10:00:00.000Z",
      agent: { agentId: "agent-1", name: "Support" },
      latestRun: { startedAt: "2026-08-20T10:00:00.000Z", completedAt: "2026-08-20T10:01:00.000Z" },
      oversized: "x".repeat(1_000),
    } as CopilotEvalCaseSummary]);
    const getQualityStats = vi.fn(async () => ({ backlog: { grounding_gaps: 1 } }));
    const listLowQualityTurns = vi.fn(async (): Promise<{ items: CopilotQualityTurn[]; total: number }> => ({ items: [qualityTurn], total: 1 }));
    const read = vi.fn(async () => ({ kind: "completed" as const, report: { themes: [{ title: "Checkout questions" }] } }));
    const refreshStatus = vi.fn(async () => ({ pending: true }));
    const descriptors = [
      ...createEvalCopilotTools({ evalResultsService: { listWithLatestRun } }),
      ...createQualityCopilotTools({ qualitySignalsService: { getQualityStats, listLowQualityTurns } }),
      ...createAudiencePulseCopilotTools({ audiencePulseService: { read, refreshStatus } }),
    ];

    expect(descriptors.map(({ name, requiredPermissions, shape }) => ({ name, requiredPermissions, shape }))).toEqual([
      { name: "eval_results", requiredPermissions: ["workspace.retrieval.query"], shape: "read" },
      { name: "quality_signals", requiredPermissions: ["workspace.quality.read"], shape: "read" },
      { name: "audience_topics", requiredPermissions: ["workspace.quality.read"], shape: "read" },
    ]);

    const evalResult = await descriptors[0].createTool(context).invoke({}, {} as never);
    const qualityResult = await descriptors[1].createTool(context).invoke({}, {} as never);
    const audienceResult = await descriptors[2].createTool(context).invoke({}, {} as never);

    expect(listWithLatestRun).toHaveBeenCalledWith("workspace-1");
    expect(getQualityStats).toHaveBeenCalledWith("workspace-1", { range: "30d", agentId: "agent-1" });
    expect(listLowQualityTurns).toHaveBeenCalledWith("workspace-1", { limit: 20, agentId: "agent-1" });
    expect(read).toHaveBeenCalledWith({ accountId: "account-1", userId: "operator-1", workspaceId: "workspace-1" });
    expect(refreshStatus).toHaveBeenCalledWith({ accountId: "account-1", userId: "operator-1", workspaceId: "workspace-1" });
    expect(JSON.stringify(evalResult).length).toBeGreaterThan(0);
    expect(JSON.stringify(evalResult)).not.toContain("x".repeat(1_000));
    expect(qualityResult).toMatchObject({ summary: { backlog: { grounding_gaps: 1 } } });
    expect(audienceResult).toMatchObject({ result: { kind: "completed" }, preparation: { pending: true } });
  });
});
