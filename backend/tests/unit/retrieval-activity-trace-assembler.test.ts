import { describe, expect, it } from "vitest";

import { ActivityTraceAssembler } from "../../src/modules/retrieval/services/retrievalActivityTraceAssembler.js";
import type { ActivityTraceAssemblerInput } from "../../src/modules/retrieval/services/retrievalActivityTraceAssembler.js";
import type { RetrievedCandidate } from "../../src/modules/retrieval/domain/retrievalPipelineTypes.js";

const baseInput = (): ActivityTraceAssemblerInput => ({
  prompt: {
    request: {
      workspaceId: "w1",
      query: "who is narayani and arudra?",
      history: [],
    },
    settings: {
      workspaceId: "w1",
      queryRewriteEnabled: true,
      semanticRewriteInstructions: "",
      lexicalRewriteInstructions: "",
      suggestedQuestionsEnabled: true,
      suggestedQuestionsCount: 3,
      rerankEnabled: true,
      vectorTopK: 20,
      similarityThreshold: 0.2,
      rerankTopK: 5,
      metadataRules: [],
      customInstruction: "",
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    contextWindow: {
      selectedMessages: [],
      truncated: false,
      selectionReason: "no-history",
    },
    originalParsedQuery: {
      originalQuery: "who is narayani and arudra?",
      semanticQuery: "who is narayani and arudra?",
      lexicalQuery: "who is narayani and arudra?",
      constraints: [],
    },
    originalPreparedQuery: {
      originalQuery: "who is narayani and arudra?",
      semanticQuery: "who is narayani and arudra?",
      lexicalQuery: "who is narayani and arudra?",
      constraints: [],
    },
    rewrittenQuery: {
      originalQuery: "who is narayani and arudra?",
      rewrittenQuery: "who is narayani and arudra?",
      effectiveQuery: "who is narayani and arudra?",
      semanticQuery: "who is narayani and arudra?",
      lexicalQuery: "who is narayani and arudra?",
      responseLanguagePolicy: "match_user_question",
      retrievalSubqueries: [
        { id: "subquery_1", label: "Narayani", semanticQuery: "who is narayani", lexicalQuery: "narayani", responseLanguagePolicy: "match_user_question" },
        { id: "subquery_2", label: "Arudra", semanticQuery: "who is arudra", lexicalQuery: "arudra", responseLanguagePolicy: "match_user_question" },
      ],
      rewriteApplied: true,
      retrievalEligible: true,
      status: "applied",
      confidence: 0.9,
    },
    activeQuery: "who is narayani and arudra?",
    activeParsedQuery: {
      originalQuery: "who is narayani and arudra?",
      semanticQuery: "who is narayani and arudra?",
      lexicalQuery: "who is narayani and arudra?",
      constraints: [],
    },
    activeSemanticQuery: "who is narayani and arudra?",
    activeRetrievalSubqueries: [
      { id: "subquery_1", label: "Narayani", semanticQuery: "who is narayani", lexicalQuery: "narayani", responseLanguagePolicy: "match_user_question" },
      { id: "subquery_2", label: "Arudra", semanticQuery: "who is arudra", lexicalQuery: "arudra", responseLanguagePolicy: "match_user_question" },
    ],
    triggerAnalysis: {
      status: "applied",
      consideredRules: [
        {
          ruleId: "events-only",
          matched: true,
          matchStrength: 0.91,
          reason: "The query is asking about an upcoming event.",
          triggerInstructionPreview: "Enact for upcoming events.",
        },
      ],
      matchedRuleIds: ["events-only"],
      unmatchedRuleIds: [],
      matchCount: 1,
      matcherVersion: "test",
    },
    promptHistory: [],
    promptHistoryReset: false,
    continuityDecision: "updated",
    activeEmbedding: [1, 0, 0],
    activeEmbeddingDurationMs: 12,
    originalContexts: [],
    rewrittenContexts: [
      {
        chunkId: "n1",
        documentId: "d1",
        title: "Narayani",
        content: "Narayani profile",
        similarity: 0.9,
      },
      {
        chunkId: "a1",
        documentId: "d2",
        title: "Arudra",
        content: "Arudra profile",
        similarity: 0.88,
      },
    ],
    lexicalContexts: [
      {
        chunkId: "ln1",
        documentId: "d1",
        title: "Narayani",
        content: "Narayani profile",
        similarity: 1,
      },
      {
        chunkId: "la1",
        documentId: "d2",
        title: "Arudra",
        content: "Arudra profile",
        similarity: 1,
      },
    ],
    retrievalBranches: [
      {
        subqueryId: "subquery_1",
        label: "Narayani",
        semanticQuery: "who is narayani",
        lexicalQuery: "narayani",
        responseLanguagePolicy: "match_user_question",
        source: "rewritten",
        semanticSearched: true,
        semanticContexts: [
          {
            chunkId: "n1",
            documentId: "d1",
            title: "Narayani",
            content: "Narayani profile",
            similarity: 0.9,
          },
        ],
        lexicalContexts: [
          {
            chunkId: "ln1",
            documentId: "d1",
            title: "Narayani",
            content: "Narayani profile",
            similarity: 1,
          },
        ],
      },
      {
        subqueryId: "subquery_2",
        label: "Arudra",
        semanticQuery: "who is arudra",
        lexicalQuery: "arudra",
        responseLanguagePolicy: "match_user_question",
        source: "rewritten",
        semanticSearched: true,
        semanticContexts: [
          {
            chunkId: "a1",
            documentId: "d2",
            title: "Arudra",
            content: "Arudra profile",
            similarity: 0.88,
          },
        ],
        lexicalContexts: [
          {
            chunkId: "la1",
            documentId: "d2",
            title: "Arudra",
            content: "Arudra profile",
            similarity: 1,
          },
        ],
      },
    ],
    vectorFallbackApplied: false,
    normalizedCandidates: [],
    mergedCandidates: [],
    scoredCandidates: [],
    appliedConstraints: [
      {
        signalKey: "metadata.category",
        mode: "hard_filter",
        outcome: "relaxed",
        summary: "category equals event",
      },
    ],
    candidateFallbackApplied: false,
    triggerBackoff: {
      applied: true,
      reason: "empty_filtered_candidates",
      relaxedRuleIds: ["events-only"],
      restoredCandidateCount: 2,
    },
    rerankedContexts: [],
    rerankStatus: "applied",
    contexts: [],
    systemPrompt: "system prompt",
    prompt: "prompt",
    citations: [],
    responseSettings: {
      citationDisplayEnabled: true,
      suggestedQuestionsEnabled: true,
      suggestedQuestionsCount: 3,
      responseLanguagePolicy: "match_user_question",
    },
  },
  diagnostics: {
    rewriteStatus: "applied",
    rerankStatus: "applied",
    originalCandidateCount: 0,
    rewrittenCandidateCount: 2,
    lexicalCandidateCount: 2,
    normalizedCandidateCount: 2,
    finalContextCount: 0,
    queryEmbeddingDurationMs: 12,
    parsedQuery: {
      originalQuery: "who is narayani and arudra?",
      semanticQuery: "who is narayani and arudra?",
      lexicalQuery: "who is narayani and arudra?",
      constraints: [],
    },
    appliedConstraints: [
      {
        signalKey: "metadata.category",
        mode: "hard_filter",
        outcome: "relaxed",
        summary: "category equals event",
      },
    ],
    candidateFallbackApplied: false,
    fallbackApplied: false,
    rewriteEligible: true,
    rewriteRan: true,
    materialDisagreement: false,
    continuityDecision: "updated",
    triggerAnalysis: {
      status: "applied",
      consideredRules: [
        {
          ruleId: "events-only",
          matched: true,
          matchStrength: 0.91,
          reason: "The query is asking about an upcoming event.",
          triggerInstructionPreview: "Enact for upcoming events.",
        },
      ],
      matchedRuleIds: ["events-only"],
      unmatchedRuleIds: [],
      matchCount: 1,
      matcherVersion: "test",
    },
    triggerBackoff: {
      applied: true,
      reason: "empty_filtered_candidates",
      relaxedRuleIds: ["events-only"],
      restoredCandidateCount: 2,
    },
    retrievalSubqueries: [
      { id: "subquery_1", label: "Narayani", semanticQuery: "who is narayani", lexicalQuery: "narayani", responseLanguagePolicy: "match_user_question" },
      { id: "subquery_2", label: "Arudra", semanticQuery: "who is arudra", lexicalQuery: "arudra", responseLanguagePolicy: "match_user_question" },
    ],
    responseLanguagePolicy: "match_user_question",
  },
  timings: {
    traceStartedAt: "2026-04-12T14:14:16.000Z",
    traceCompletedAt: "2026-04-12T14:14:24.000Z",
    totalDurationMs: 8_000,
    retrievalContext: { startedAt: "2026-04-12T14:14:16.000Z", durationMs: 10 },
    queryInterpretation: { startedAt: "2026-04-12T14:14:16.010Z", durationMs: 20 },
    semanticRetrieval: { startedAt: "2026-04-12T14:14:16.030Z", durationMs: 600 },
    lexicalRetrieval: { startedAt: "2026-04-12T14:14:16.630Z", durationMs: 400 },
    candidatePreparation: { startedAt: "2026-04-12T14:14:17.030Z", durationMs: 20 },
    contextSelection: { startedAt: "2026-04-12T14:14:17.050Z", durationMs: 20 },
    promptAssembly: { startedAt: "2026-04-12T14:14:17.070Z", durationMs: 10 },
    diagnostics: { startedAt: "2026-04-12T14:14:17.080Z", durationMs: 10 },
  },
});

describe("activity trace assembler", () => {
  it("emits branch stages for decomposed retrieval subqueries", () => {
    const assembler = new ActivityTraceAssembler();

    const trace = assembler.assemble(baseInput());

    expect(trace.stages.filter((stage) => stage.kind === "semantic_rewritten")).toHaveLength(2);
    expect(trace.stages.filter((stage) => stage.kind === "lexical")).toHaveLength(2);
    expect(trace.stages).toContainEqual(
      expect.objectContaining({
        stageId: "trigger_analysis",
        kind: "trigger_analysis",
        status: "applied",
      }),
    );
    expect(trace.summary?.retrievalSubqueries).toEqual([
      expect.objectContaining({ label: "Narayani", lexicalQuery: "narayani", responseLanguagePolicy: "match_user_question" }),
      expect.objectContaining({ label: "Arudra", lexicalQuery: "arudra", responseLanguagePolicy: "match_user_question" }),
    ]);
    expect(trace.summary?.responseLanguagePolicy).toBe("match_user_question");
    expect(trace.summary?.triggerAnalysis).toMatchObject({
      matchedRuleIds: ["events-only"],
      matchCount: 1,
    });
    expect(trace.summary?.triggerBackoff).toMatchObject({
      applied: true,
      relaxedRuleIds: ["events-only"],
    });
    expect(trace.summary?.appliedConstraints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          signalKey: "metadata.category",
          outcome: "relaxed",
          summary: "category equals event",
        }),
      ]),
    );
  });

  it("collapses branches that share a semantic query into a single semantic stage", () => {
    const assembler = new ActivityTraceAssembler();
    const input = baseInput();
    // Lexical-alternative split: both branches share one semantic query but run
    // distinct lexical searches (the common "OR" case).
    const sharedSemantic = "how to contact support";
    input.prompt.retrievalBranches = [
      {
        subqueryId: "subquery_1",
        label: "email",
        semanticQuery: sharedSemantic,
        lexicalQuery: "email",
        responseLanguagePolicy: "match_user_question",
        source: "rewritten",
        semanticSearched: true,
        semanticContexts: [
          { chunkId: "s1", documentId: "d1", title: "Contact", content: "contact", similarity: 0.9 },
        ],
        lexicalContexts: [
          { chunkId: "l1", documentId: "d1", title: "Email", content: "email", similarity: 1 },
        ],
      },
      {
        subqueryId: "subquery_2",
        label: "phone",
        semanticQuery: sharedSemantic,
        lexicalQuery: "phone",
        responseLanguagePolicy: "match_user_question",
        source: "rewritten",
        semanticSearched: true,
        // Same shared semantic search → identical contexts as the first branch.
        semanticContexts: [
          { chunkId: "s1", documentId: "d1", title: "Contact", content: "contact", similarity: 0.9 },
        ],
        lexicalContexts: [
          { chunkId: "l2", documentId: "d1", title: "Phone", content: "phone", similarity: 1 },
        ],
      },
    ];

    const trace = assembler.assemble(input);

    const semanticStages = trace.stages.filter((stage) => stage.kind === "semantic_rewritten");
    expect(semanticStages).toHaveLength(1);
    expect(semanticStages[0]?.stageId).toBe("semantic_rewritten");
    expect(semanticStages[0]?.label).toBe("Semantic retrieval");
    // Lexical fan-out is preserved.
    expect(trace.stages.filter((stage) => stage.kind === "lexical")).toHaveLength(2);
  });

  it("omits a semantic stage for lexical-only (capped) branches", () => {
    const assembler = new ActivityTraceAssembler();
    const input = baseInput();
    // Third branch fell outside the per-turn semantic cap: lexical-only.
    input.prompt.retrievalBranches = [
      {
        subqueryId: "subquery_1",
        label: "alpha",
        semanticQuery: "who is alpha",
        lexicalQuery: "alpha",
        responseLanguagePolicy: "match_user_question",
        source: "rewritten",
        semanticSearched: true,
        semanticContexts: [
          { chunkId: "s1", documentId: "d1", title: "Alpha", content: "alpha", similarity: 0.9 },
        ],
        lexicalContexts: [
          { chunkId: "l1", documentId: "d1", title: "Alpha", content: "alpha", similarity: 1 },
        ],
      },
      {
        subqueryId: "subquery_2",
        label: "beta",
        semanticQuery: "who is beta",
        lexicalQuery: "beta",
        responseLanguagePolicy: "match_user_question",
        source: "rewritten",
        semanticSearched: true,
        semanticContexts: [
          { chunkId: "s2", documentId: "d2", title: "Beta", content: "beta", similarity: 0.88 },
        ],
        lexicalContexts: [
          { chunkId: "l2", documentId: "d2", title: "Beta", content: "beta", similarity: 1 },
        ],
      },
      {
        subqueryId: "subquery_3",
        label: "gamma",
        semanticQuery: "who is gamma",
        lexicalQuery: "gamma",
        responseLanguagePolicy: "match_user_question",
        source: "rewritten",
        semanticSearched: false,
        semanticContexts: [],
        lexicalContexts: [
          { chunkId: "l3", documentId: "d3", title: "Gamma", content: "gamma", similarity: 1 },
        ],
      },
    ];

    const trace = assembler.assemble(input);

    // Only the two searched semantic queries produce semantic stages...
    expect(trace.stages.filter((stage) => stage.kind === "semantic_rewritten")).toHaveLength(2);
    // ...but every branch still contributes a lexical stage.
    expect(trace.stages.filter((stage) => stage.kind === "lexical")).toHaveLength(3);
  });

  it("labels normalized fused and per-source scores in candidate trace output", () => {
    const assembler = new ActivityTraceAssembler();
    const input = baseInput();
    const candidate: RetrievedCandidate = {
      chunkId: "n1",
      documentId: "d1",
      title: "Narayani",
      content: "Narayani profile",
      similarity: 0.93,
      fusedScore: 0.93,
      retrievalSources: ["semantic_rewritten", "lexical"],
      retrievalText: "Narayani profile",
      semanticScore: 0.9,
      lexicalScore: 1,
      lexicalRankScore: 0.4,
      semanticRank: 1,
      lexicalRank: 1,
    };
    input.prompt.normalizedCandidates = [candidate];
    input.prompt.mergedCandidates = [candidate];
    input.prompt.scoredCandidates = [candidate];

    const trace = assembler.assemble(input);
    const preparation = trace.stages.find((stage) => stage.kind === "candidate_preparation");
    const outputs = preparation?.outputs as {
      topCandidates?: Array<Record<string, unknown>>;
    } | undefined;

    expect(outputs?.topCandidates?.[0]).toMatchObject({
      similarity: 0.93,
      fusedScore: 0.93,
      semanticScore: 0.9,
      lexicalScore: 1,
      lexicalRankScore: 0.4,
      semanticRank: 1,
      lexicalRank: 1,
    });
    for (const field of ["similarity", "fusedScore", "semanticScore", "lexicalScore"] as const) {
      expect(outputs?.topCandidates?.[0]?.[field]).toEqual(expect.any(Number));
      expect(outputs?.topCandidates?.[0]?.[field]).toBeGreaterThanOrEqual(0);
      expect(outputs?.topCandidates?.[0]?.[field]).toBeLessThanOrEqual(1);
    }
  });
});
