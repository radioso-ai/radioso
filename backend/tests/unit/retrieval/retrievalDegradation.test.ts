import { describe, expect, it, vi } from "vitest";

import { CandidateRetrievalStageService } from "../../../src/modules/retrieval/services/candidateRetrievalStage.js";
import { RetrievalExecutionTelemetryService } from "../../../src/modules/retrieval/services/retrievalExecutionTelemetryService.js";
import { buildCandidateRetrievalTraceAttributes } from "../../../src/modules/retrieval/services/retrievalPipelineStages.js";

const lexicalChunk = {
  chunkId: "chunk-lexical",
  documentId: "document-1",
  title: "Lexical result",
  content: "Search remains available without semantic candidates.",
  searchText: "Lexical result Search remains available without semantic candidates.",
  similarity: 0,
  lexicalRank: 1,
  lexicalRankScore: 1,
  chunkIndex: 0,
  startOffset: 0,
  endOffset: 57,
  metadata: {},
};

const input = {
  request: {
    workspaceId: "workspace-1",
    query: "semantic outage",
    history: [],
  },
  settings: {
    workspaceId: "workspace-1",
    queryRewriteEnabled: false,
    temporalStructuredLookupEnabled: true,
    temporalBoostUpcomingEnabled: true,
    temporalDeterministicSortEnabled: true,
    semanticRewriteInstructions: "",
    lexicalRewriteInstructions: "",
    suggestedQuestionsEnabled: true,
    suggestedQuestionsCount: 3,
    rerankEnabled: false,
    vectorTopK: 20,
    similarityThreshold: 0.2,
    rerankTopK: 5,
    customInstruction: "",
    metadataRules: [],
    createdAt: new Date(0),
    updatedAt: new Date(0),
  },
  contextWindow: {
    selectedMessages: [],
    truncated: false,
    selectionReason: "full-history",
  },
  originalParsedQuery: {
    semanticQuery: "semantic outage",
    lexicalQuery: "semantic outage",
    constraints: [],
  },
  originalPreparedQuery: {
    semanticQuery: "semantic outage",
    lexicalQuery: "semantic outage",
    constraints: [],
  },
  rewrittenQuery: {
    originalQuery: "semantic outage",
    rewrittenQuery: "semantic outage",
    effectiveQuery: "semantic outage",
    semanticQuery: "semantic outage",
    lexicalQuery: "semantic outage",
    responseIntent: "retrieval",
    rewriteApplied: false,
    retrievalEligible: true,
    status: "skipped",
    confidence: 1,
  },
  responseIntent: "retrieval",
  activeQuery: "semantic outage",
  activeParsedQuery: {
    semanticQuery: "semantic outage",
    lexicalQuery: "semantic outage",
    constraints: [],
  },
  activeSemanticQuery: "semantic outage",
  activeRetrievalSubqueries: [{
    id: "primary",
    label: "primary",
    semanticQuery: "semantic outage",
    lexicalQuery: "semantic outage",
  }],
  triggerAnalysis: {
    status: "skipped_not_configured",
    consideredRules: [],
    matchedRuleIds: [],
    unmatchedRuleIds: [],
    matchCount: 0,
    matcherVersion: "none",
  },
  promptHistory: [],
  promptHistoryReset: false,
  continuityDecision: "unchanged",
} as const;

describe("retrieval semantic degradation", () => {
  it("continues with lexical candidates when query embedding is unavailable", async () => {
    const vectorSearch = { search: vi.fn() };
    const lexicalSearch = {
      search: vi.fn().mockResolvedValue([lexicalChunk]),
    };
    const stage = new CandidateRetrievalStageService(
      {
        embedQueries: vi.fn().mockRejectedValue(
          new Error("embedding provider unavailable"),
        ),
      },
      vectorSearch as never,
      lexicalSearch as never,
      { hydrate: vi.fn() } as never,
    );

    const result = await stage.execute(input as never);

    expect(result.lexicalContexts).toEqual([lexicalChunk]);
    expect(result.rewrittenContexts).toEqual([]);
    expect(result.activeEmbedding).toEqual([]);
    expect(result.vectorFallbackApplied).toBe(true);
    expect(result.semanticRetrievalAvailability).toBe("unavailable");
    expect(result.semanticRetrievalFailureReason).toBe(
      "query_embedding_unavailable",
    );
    expect(result.retrievalBranches[0]?.semanticSearched).toBe(false);
    expect(vectorSearch.search).not.toHaveBeenCalled();
    expect(buildCandidateRetrievalTraceAttributes(result)).toMatchObject({
      "retrieval.semantic.availability": "unavailable",
      "retrieval.semantic.failure_reason": "query_embedding_unavailable",
    });
  });

  it("continues with lexical candidates when active-space vector search is unavailable", async () => {
    const lexicalSearch = {
      search: vi.fn().mockResolvedValue([lexicalChunk]),
    };
    const stage = new CandidateRetrievalStageService(
      {
        embedQueries: vi.fn().mockResolvedValue({
          space: {
            id: "space-active",
            dimensions: 3,
            distanceMetric: "cosine",
          },
          vectors: [[0.1, 0.2, 0.3]],
        }),
      },
      {
        search: vi.fn().mockRejectedValue(
          new Error("vector backend unavailable"),
        ),
      } as never,
      lexicalSearch as never,
      { hydrate: vi.fn() } as never,
    );

    const result = await stage.execute(input as never);

    expect(result.lexicalContexts).toEqual([lexicalChunk]);
    expect(result.rewrittenContexts).toEqual([]);
    expect(result.activeEmbedding).toEqual([0.1, 0.2, 0.3]);
    expect(result.vectorFallbackApplied).toBe(true);
    expect(result.semanticRetrievalAvailability).toBe("unavailable");
    expect(result.semanticRetrievalFailureReason).toBe(
      "vector_search_unavailable",
    );
    expect(result.retrievalBranches[0]?.semanticSearched).toBe(true);
  });

  it("continues with semantic candidates when lexical search fails", async () => {
    const semanticChunk = { ...lexicalChunk, chunkId: "chunk-semantic" };
    const lexicalSearch = {
      search: vi.fn().mockRejectedValue(new Error("canceling statement due to statement timeout")),
    };
    const stage = new CandidateRetrievalStageService(
      {
        embedQueries: vi.fn().mockResolvedValue({
          space: { id: "space-active", dimensions: 3, distanceMetric: "cosine" },
          vectors: [[0.1, 0.2, 0.3]],
        }),
      },
      { search: vi.fn().mockResolvedValue([semanticChunk]) } as never,
      lexicalSearch as never,
      { hydrate: vi.fn().mockResolvedValue([semanticChunk]) } as never,
    );

    const result = await stage.execute(input as never);

    expect(result.lexicalContexts).toEqual([]);
    expect(result.degradedRetrievalChannels).toContain("lexical");
    // Semantic must be unaffected: a lexical outage is not a vector outage.
    expect(result.semanticRetrievalAvailability).toBe("available");
    expect(buildCandidateRetrievalTraceAttributes(result)).toMatchObject({
      "retrieval.degraded_channels": "lexical",
    });
  });

  it("continues when the temporal structured lookup fails", async () => {
    const temporalInput = {
      ...input,
      rewrittenQuery: {
        ...input.rewrittenQuery,
        structuredResult: {
          queryShape: "event_date_lookup",
          temporalQueryMode: "listing",
        },
      },
    };
    const stage = new CandidateRetrievalStageService(
      {
        embedQueries: vi.fn().mockResolvedValue({
          space: { id: "space-active", dimensions: 3, distanceMetric: "cosine" },
          vectors: [[0.1, 0.2, 0.3]],
        }),
      },
      { search: vi.fn().mockResolvedValue([]) } as never,
      { search: vi.fn().mockResolvedValue([lexicalChunk]) } as never,
      { hydrate: vi.fn().mockResolvedValue([]) } as never,
      {
        findUpcoming: vi.fn().mockRejectedValue(
          new Error("canceling statement due to statement timeout"),
        ),
      } as never,
    );

    const result = await stage.execute(temporalInput as never);

    expect(result.temporalContexts).toEqual([]);
    expect(result.degradedRetrievalChannels).toContain("temporal");
    expect(result.lexicalContexts).toEqual([lexicalChunk]);
  });

  it("reports no degraded channels when every channel succeeds", async () => {
    const stage = new CandidateRetrievalStageService(
      {
        embedQueries: vi.fn().mockResolvedValue({
          space: { id: "space-active", dimensions: 3, distanceMetric: "cosine" },
          vectors: [[0.1, 0.2, 0.3]],
        }),
      },
      { search: vi.fn().mockResolvedValue([]) } as never,
      { search: vi.fn().mockResolvedValue([lexicalChunk]) } as never,
      { hydrate: vi.fn().mockResolvedValue([]) } as never,
    );

    const result = await stage.execute(input as never);

    expect(result.degradedRetrievalChannels).toEqual([]);
    expect(buildCandidateRetrievalTraceAttributes(result)).toMatchObject({
      "retrieval.degraded_channels": "none",
    });
  });

  it("records only bounded semantic availability and failure codes in diagnostics", async () => {
    const events: unknown[] = [];
    const telemetry = new RetrievalExecutionTelemetryService({
      emit: vi.fn(async (event) => {
        events.push(event);
      }),
    } as never);

    const diagnostics = await telemetry.create({
      workspaceId: "workspace-1",
      rewriteStatus: "skipped",
      rerankStatus: "skipped",
      originalCandidateCount: 0,
      rewrittenCandidateCount: 0,
      lexicalCandidateCount: 1,
      normalizedCandidateCount: 1,
      finalContextCount: 1,
      candidateFallbackApplied: true,
      semanticRetrievalAvailability: "unavailable",
      semanticRetrievalFailureReason: "vector_search_unavailable",
    });

    expect(diagnostics).toMatchObject({
      semanticRetrievalAvailability: "unavailable",
      semanticRetrievalFailureReason: "vector_search_unavailable",
      fallbackApplied: true,
    });
    expect(events).toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({
          semanticRetrievalAvailability: "unavailable",
          semanticRetrievalFailureReason: "vector_search_unavailable",
        }),
        tags: expect.objectContaining({
          semantic_availability: "unavailable",
          semantic_failure_reason: "vector_search_unavailable",
        }),
      }),
    ]);
  });
});
