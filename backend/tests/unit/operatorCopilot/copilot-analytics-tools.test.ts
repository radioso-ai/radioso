import { describe, expect, it, vi } from "vitest";

import { createAudiencePulseCopilotTools } from "../../../src/modules/operatorCopilot/tools/audiencePulse.js";
import { createEvalCopilotTools } from "../../../src/modules/operatorCopilot/tools/eval.js";
import { createQualityCopilotTools } from "../../../src/modules/operatorCopilot/tools/quality.js";

const context = {
  workspaceId: "workspace-1",
  accountId: "account-1",
  operatorUserId: "operator-1",
  pageContext: { view: "evals" as const, agentId: "agent-1", conversationId: null, selection: null, entities: [] },
};

describe("copilot analytics readers", () => {
  it("provides bounded eval, quality, and stored audience readers with their required permissions", async () => {
    const listWithLatestRun = vi.fn(async () => [{
      id: "case-1",
      name: "Checkout",
      agent: { agentId: "agent-1" },
      latestRun: { status: "fail" },
      oversized: "x".repeat(1_000),
    }]);
    const getQualityStats = vi.fn(async () => ({ backlog: { grounding_gaps: 1 } }));
    const listLowQualityTurns = vi.fn(async () => ({ items: [{ assistantMessageId: "message-1" }], total: 1 }));
    const read = vi.fn(async () => ({ kind: "completed" as const, report: { themes: [{ title: "Checkout questions" }] } }));
    const descriptors = [
      ...createEvalCopilotTools({ evalResultsService: { listWithLatestRun } }),
      ...createQualityCopilotTools({ qualitySignalsService: { getQualityStats, listLowQualityTurns } }),
      ...createAudiencePulseCopilotTools({ audiencePulseService: { read } }),
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
    expect(JSON.stringify(evalResult).length).toBeGreaterThan(0);
    expect(JSON.stringify(evalResult)).not.toContain("x".repeat(1_000));
    expect(qualityResult).toMatchObject({ summary: { backlog: { grounding_gaps: 1 } } });
    expect(audienceResult).toMatchObject({ result: { kind: "completed" } });
  });
});
