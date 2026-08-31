import { describe, expect, it } from "vitest";

import { resolveAgentRetrievalScope } from "../../../src/modules/retrieval/domain/agentRetrievalScope.js";
import { RetrievalSearchService } from "../../../src/modules/retrieval/services/retrievalSearchService.js";
import type { AgentRetrievalScopePort } from "../../../src/modules/retrieval/domain/agentRetrievalScope.js";

const pipelineResult = {
  contexts: [{
    documentId: "d1",
    chunkId: "c1",
    title: "Refunds",
    content: "Refunds are issued within 14 days.",
    metadata: { locale: "en" },
    relevanceScore: 0.82,
    similarity: 0.71,
  }],
  rewrittenQuery: "refund window",
  diagnostics: { parsedQuery: null },
  trace: { traceId: "t1", startedAt: new Date().toISOString(), stages: [], links: [] },
} as never;

const recordingPipeline = () => {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    port: {
      run: async (input: Record<string, unknown>) => {
        calls.push(input);
        return pipelineResult;
      },
    } as never,
  };
};

const agentScopePort = (scope: unknown): AgentRetrievalScopePort => ({
  resolveForAgent: async () => scope as never,
});

describe("resolveAgentRetrievalScope", () => {
  it("carries the agent's source scope, answering behavior, and skill settings", () => {
    const scope = resolveAgentRetrievalScope({
      sourceScope: { mode: "selected", sourceIds: ["s1"] },
      customInstruction: "Answer in a single sentence.",
      citationDisplayEnabled: false,
      retrievalEnabled: true,
      skillSettings: { "retrieval.answer": { topK: 3 } },
    });

    expect(scope).toEqual({
      sourceScope: { mode: "selected", sourceIds: ["s1"] },
      responseBehaviorEnabled: true,
      responseBehavior: {
        customInstruction: "Answer in a single sentence.",
        citationDisplayEnabled: false,
      },
      agentSkillSettings: { "retrieval.answer": { topK: 3 } },
    });
  });
});

describe("RetrievalSearchService agent scoping", () => {
  it("runs on workspace defaults when no agent is named", async () => {
    const pipeline = recordingPipeline();
    const service = new RetrievalSearchService(pipeline.port);

    const result = await service.search({ workspaceId: "w1", query: "refunds" });

    expect(pipeline.calls[0]?.agentSkillSettings).toBeUndefined();
    expect(pipeline.calls[0]?.sourceScope).toBeUndefined();
    expect(result.agentScope).toBeNull();
  });

  it("runs on the named agent's retrieval settings and attributes the result to it", async () => {
    const pipeline = recordingPipeline();
    const service = new RetrievalSearchService(pipeline.port, agentScopePort({
      sourceScope: { mode: "selected", sourceIds: ["s1"] },
      responseBehaviorEnabled: true,
      responseBehavior: { customInstruction: "", citationDisplayEnabled: true },
      agentSkillSettings: { "retrieval.answer": { topK: 3 } },
      retrievalEnabled: false,
    }));

    const result = await service.search({ workspaceId: "w1", query: "refunds", agentId: "a1" });

    expect(pipeline.calls[0]?.agentSkillSettings).toEqual({ "retrieval.answer": { topK: 3 } });
    expect(pipeline.calls[0]?.sourceScope).toEqual({ mode: "selected", sourceIds: ["s1"] });
    expect(pipeline.calls[0]?.retrievalEnabled).toBeUndefined();
    expect(result.agentScope).toEqual({ agentId: "a1", retrievalEnabled: false });
  });

  it("refuses to measure an agent that cannot be resolved rather than falling back to workspace defaults", async () => {
    const pipeline = recordingPipeline();
    const service = new RetrievalSearchService(pipeline.port, agentScopePort(null));

    await expect(service.search({ workspaceId: "w1", query: "refunds", agentId: "missing" }))
      .rejects.toThrow(/agent/i);
    expect(pipeline.calls).toHaveLength(0);
  });

  it("refuses an agent-scoped search when no scope resolver is wired", async () => {
    const pipeline = recordingPipeline();
    const service = new RetrievalSearchService(pipeline.port);

    await expect(service.search({ workspaceId: "w1", query: "refunds", agentId: "a1" }))
      .rejects.toThrow(/agent/i);
    expect(pipeline.calls).toHaveLength(0);
  });

  it("reports the relevance score the pipeline scored the chunk with", async () => {
    const pipeline = recordingPipeline();
    const service = new RetrievalSearchService(pipeline.port);

    const result = await service.search({ workspaceId: "w1", query: "refunds" });

    expect(result.results[0]?.score).toBe(0.82);
  });
});
