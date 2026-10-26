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

const pipelineWithDiagnostics = (diagnostics: Record<string, unknown>, contexts: Record<string, unknown>[] = []) => ({
  port: {
    run: async () => ({
      contexts,
      rewrittenQuery: "courses in January",
      diagnostics,
      trace: { traceId: "t1", startedAt: new Date().toISOString(), stages: [], links: [] },
    }),
  } as never,
});

describe("RetrievalSearchService requested date range visibility", () => {
  it("reports no resolved range and no drop reason when the question named none", async () => {
    const pipeline = pipelineWithDiagnostics({ parsedQuery: null });
    const service = new RetrievalSearchService(pipeline.port);

    const result = await service.search({ workspaceId: "w1", query: "what is the refund policy" });

    expect(result.requestedDateRange).toBeNull();
    expect(result.requestedDateRangeDropReason).toBeNull();
    expect(result.requestedRangeLookup).toEqual({ status: "not_requested", candidateCount: 0 });
  });

  it("reports the resolved range and that the requested-range lookup ran", async () => {
    const pipeline = pipelineWithDiagnostics({
      parsedQuery: null,
      temporalDateRange: { dateFrom: "2027-01-03", dateTo: "2027-01-06" },
      temporalCandidateCount: 3,
      temporalStructuredLookupEnabled: true,
    });
    const service = new RetrievalSearchService(pipeline.port);

    const result = await service.search({ workspaceId: "w1", query: "which courses run from 3 to 6 January 2027" });

    expect(result.requestedDateRange).toEqual({ dateFrom: "2027-01-03", dateTo: "2027-01-06" });
    expect(result.requestedDateRangeDropReason).toBeNull();
    expect(result.requestedRangeLookup).toEqual({ status: "ran", candidateCount: 3 });
  });

  it("reports why a model-resolved range was dropped instead of a silent null", async () => {
    const pipeline = pipelineWithDiagnostics({
      parsedQuery: null,
      rewriteProposal: { requestedDateRangeDropReason: "too_long" },
    });
    const service = new RetrievalSearchService(pipeline.port);

    const result = await service.search({ workspaceId: "w1", query: "courses over the next three years" });

    expect(result.requestedDateRange).toBeNull();
    expect(result.requestedDateRangeDropReason).toBe("too_long");
    expect(result.requestedRangeLookup).toEqual({ status: "not_requested", candidateCount: 0 });
  });

  it("does not report the lookup as having run when structured lookup is disabled, even with a resolved range", async () => {
    const pipeline = pipelineWithDiagnostics({
      parsedQuery: null,
      temporalDateRange: { dateFrom: "2027-01-03", dateTo: "2027-01-06" },
      temporalCandidateCount: 0,
      temporalStructuredLookupEnabled: false,
    });
    const service = new RetrievalSearchService(pipeline.port);

    const result = await service.search({ workspaceId: "w1", query: "which courses run from 3 to 6 January 2027" });

    expect(result.requestedDateRange).toEqual({ dateFrom: "2027-01-03", dateTo: "2027-01-06" });
    expect(result.requestedRangeLookup).toEqual({ status: "not_requested", candidateCount: 0 });
  });

  it("reports failed, not ran, when the candidate stage degraded the temporal channel after an error", async () => {
    const pipeline = pipelineWithDiagnostics({
      parsedQuery: null,
      temporalDateRange: { dateFrom: "2027-01-03", dateTo: "2027-01-06" },
      temporalCandidateCount: 0,
      temporalStructuredLookupEnabled: true,
      degradedRetrievalChannels: ["temporal"],
    });
    const service = new RetrievalSearchService(pipeline.port);

    const result = await service.search({ workspaceId: "w1", query: "which courses run from 3 to 6 January 2027" });

    expect(result.requestedRangeLookup).toEqual({ status: "failed", candidateCount: 0 });
  });

  it("marks each result's own dates and whether they fall in the requested range", async () => {
    const pipeline = pipelineWithDiagnostics(
      {
        parsedQuery: null,
        temporalDateRange: { dateFrom: "2027-01-03", dateTo: "2027-01-06" },
        temporalCandidateCount: 1,
        temporalStructuredLookupEnabled: true,
      },
      [
        {
          documentId: "d1",
          chunkId: "c1",
          title: "January course listing",
          content: "Runs 3-6 January 2027.",
          metadata: { dateFrom: "2027-01-03", dateTo: "2027-01-06" },
          similarity: 0.6,
          retrievalSources: ["temporal"],
        },
        {
          documentId: "d2",
          chunkId: "c2",
          title: "December course listing",
          content: "Runs every December.",
          metadata: { dateFrom: "2026-12-01", dateTo: "2026-12-31" },
          similarity: 0.9,
          retrievalSources: ["semantic_rewritten"],
        },
        {
          documentId: "d3",
          chunkId: "c3",
          title: "Undated policy",
          content: "General enrollment policy.",
          metadata: {},
          similarity: 0.5,
          retrievalSources: ["lexical"],
        },
      ],
    );
    const service = new RetrievalSearchService(pipeline.port);

    const result = await service.search({ workspaceId: "w1", query: "which courses run from 3 to 6 January 2027" });

    expect(result.results).toEqual([
      expect.objectContaining({
        chunkId: "c1",
        dateFrom: "2027-01-03",
        dateTo: "2027-01-06",
        datedInRequestedRange: true,
        fromRequestedRangeLookup: true,
      }),
      expect.objectContaining({
        chunkId: "c2",
        dateFrom: "2026-12-01",
        dateTo: "2026-12-31",
        datedInRequestedRange: false,
        fromRequestedRangeLookup: false,
      }),
      expect.objectContaining({
        chunkId: "c3",
        dateFrom: null,
        dateTo: null,
        datedInRequestedRange: false,
        fromRequestedRangeLookup: false,
      }),
    ]);
  });

  it("leaves per-result date fields null-ish when no range was requested", async () => {
    const pipeline = pipelineWithDiagnostics({ parsedQuery: null }, [{
      documentId: "d1",
      chunkId: "c1",
      title: "Refunds",
      content: "Refunds are issued within 14 days.",
      metadata: {},
      similarity: 0.7,
      retrievalSources: ["lexical"],
    }]);
    const service = new RetrievalSearchService(pipeline.port);

    const result = await service.search({ workspaceId: "w1", query: "refund window" });

    expect(result.results[0]).toEqual(expect.objectContaining({
      dateFrom: null,
      dateTo: null,
      datedInRequestedRange: null,
      fromRequestedRangeLookup: false,
    }));
  });
});
