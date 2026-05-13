import { describe, expect, it } from "vitest";

import { RetrievalTraceAssembler } from "../../src/modules/retrieval/services/retrievalTraceAssembler.js";

describe("retrieval trace assembler", () => {
  it("emits branch stages for decomposed retrieval subqueries", () => {
    const assembler = new RetrievalTraceAssembler();

    const trace = assembler.assemble({
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
          citationDisplayEnabled: true,
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
          responseIntent: "retrieval",
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
        responseIntent: "retrieval",
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
});
