import { describe, expect, it } from "vitest";

import { CandidateRetrievalStageService } from "../../src/modules/retrieval/services/candidateRetrievalStage.js";
import { EmbeddingService } from "../../src/modules/retrieval/services/embeddingService.js";

describe("candidate retrieval branches", () => {
  it("runs semantic and lexical retrieval separately for each active subquery", async () => {
    const vectorQueries: number[] = [];
    const lexicalQueries: string[] = [];
    const lexicalPlans: unknown[] = [];
    const stage = new CandidateRetrievalStageService(
      new EmbeddingService({
        async embedTexts(texts) {
          return texts.map((_, index) => [index + 1]);
        },
      }),
      {
        async search(input) {
          vectorQueries.push(Number(input.queryEmbedding[0]));
          return [
            {
              chunkId: `semantic-${input.queryEmbedding[0]}`,
              documentId: `doc-semantic-${input.queryEmbedding[0]}`,
              title: input.queryEmbedding[0] === 1 ? "Narayani" : "Arudra",
              content: "profile",
              similarity: 0.9,
            },
          ];
        },
      },
      {
        async search(input) {
          lexicalQueries.push(input.query);
          lexicalPlans.push(input.lexicalPlan);
          return [
            {
              chunkId: `lexical-${input.query}`,
              documentId: `doc-lexical-${input.query}`,
              title: input.query,
              content: "profile",
              similarity: 0.8,
            },
          ];
        },
      },
    );

    const result = await stage.execute({
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
        rerankEnabled: false,
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
        retrievalSubqueries: [
          { id: "subquery_1", label: "Narayani", semanticQuery: "who is narayani", lexicalQuery: "narayani" },
          { id: "subquery_2", label: "Arudra", semanticQuery: "who is arudra", lexicalQuery: "arudra" },
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
        { id: "subquery_1", label: "Narayani", semanticQuery: "who is narayani", lexicalQuery: "narayani" },
        { id: "subquery_2", label: "Arudra", semanticQuery: "who is arudra", lexicalQuery: "arudra" },
      ],
      triggerAnalysis: {
        status: "skipped_not_configured",
        consideredRules: [],
        matchedRuleIds: [],
        unmatchedRuleIds: [],
        matchCount: 0,
        matcherVersion: "test",
      },
      promptHistory: [],
      continuityDecision: "updated",
    });

    expect(vectorQueries).toEqual([1, 2]);
    expect(lexicalQueries).toEqual(["narayani", "arudra"]);
    expect(result.retrievalBranches).toHaveLength(2);
    expect(result.retrievalBranches.map((branch) => branch.label)).toEqual(["Narayani", "Arudra"]);
    expect(result.rewrittenContexts).toHaveLength(2);
    expect(result.lexicalContexts).toHaveLength(2);
  });

  it("uses the active workspace embedding model for semantic query embeddings", async () => {
    const seenModels: Array<string | undefined> = [];
    const seenVectorModels: Array<string | undefined> = [];
    const stage = new CandidateRetrievalStageService(
      new EmbeddingService({
        async embedTexts(texts, options?: { model?: string }) {
          seenModels.push(options?.model);
          return texts.map(() => [1]);
        },
      }),
      {
        async search(input) {
          seenVectorModels.push(input.embeddingModel);
          return [];
        },
      },
      {
        async search() {
          return [];
        },
      },
      {
        async getForWorkspace(workspaceId: string) {
          return {
            workspaceId,
            chunkingStrategy: "fixed_window" as const,
            fixedWindowChunkSize: 800,
            fixedWindowChunkOverlap: 120,
            structuredMinChunkSize: 24,
            structuredMaxChunkSize: 220,
            embeddingModel: "text-embedding-3-small" as const,
            pendingEmbeddingModel: "text-embedding-3-large" as const,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        },
      },
    );

    await stage.execute({
      request: {
        workspaceId: "w1",
        query: "account recovery",
        history: [],
      },
      settings: {
        workspaceId: "w1",
        queryRewriteEnabled: true,
        semanticRewriteInstructions: "",
        lexicalRewriteInstructions: "",
        suggestedQuestionsEnabled: true,
        suggestedQuestionsCount: 3,
        rerankEnabled: false,
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
        originalQuery: "account recovery",
        semanticQuery: "account recovery",
        lexicalQuery: "account recovery",
        constraints: [],
      },
      originalPreparedQuery: {
        originalQuery: "account recovery",
        semanticQuery: "account recovery",
        lexicalQuery: "account recovery",
        constraints: [],
      },
      rewrittenQuery: {
        originalQuery: "account recovery",
        rewrittenQuery: "account recovery",
        effectiveQuery: "account recovery",
        semanticQuery: "account recovery",
        lexicalQuery: "account recovery",
        responseIntent: "retrieval",
        retrievalSubqueries: [
          { id: "subquery_1", label: "account recovery", semanticQuery: "account recovery", lexicalQuery: "account recovery" },
        ],
        rewriteApplied: true,
        retrievalEligible: true,
        status: "applied",
        confidence: 0.9,
      },
      responseIntent: "retrieval",
      activeQuery: "account recovery",
      activeParsedQuery: {
        originalQuery: "account recovery",
        semanticQuery: "account recovery",
        lexicalQuery: "account recovery",
        constraints: [],
      },
      activeSemanticQuery: "account recovery",
      activeRetrievalSubqueries: [
        { id: "subquery_1", label: "account recovery", semanticQuery: "account recovery", lexicalQuery: "account recovery" },
      ],
      triggerAnalysis: {
        status: "skipped_not_configured",
        consideredRules: [],
        matchedRuleIds: [],
        unmatchedRuleIds: [],
        matchCount: 0,
        matcherVersion: "test",
      },
      promptHistory: [],
      continuityDecision: "updated",
    });

    expect(seenModels).toEqual(["text-embedding-3-small"]);
    expect(seenVectorModels).toEqual(["text-embedding-3-small"]);
  });

  it("reuses identical semantic retrieval while still running distinct lexical branches", async () => {
    const embeddedTexts: string[][] = [];
    const vectorQueries: number[] = [];
    const lexicalQueries: string[] = [];
    const lexicalPlans: unknown[] = [];
    const stage = new CandidateRetrievalStageService(
      new EmbeddingService({
        async embedTexts(texts) {
          embeddedTexts.push(texts);
          return texts.map((_, index) => [index + 1]);
        },
      }),
      {
        async search(input) {
          vectorQueries.push(Number(input.queryEmbedding[0]));
          return [
            {
              chunkId: `semantic-${input.queryEmbedding[0]}`,
              documentId: `doc-semantic-${input.queryEmbedding[0]}`,
              title: "Account recovery",
              content: "recovery",
              similarity: 0.9,
            },
          ];
        },
      },
      {
        async search(input) {
          lexicalQueries.push(input.query);
          lexicalPlans.push(input.lexicalPlan);
          return [
            {
              chunkId: `lexical-${input.query}`,
              documentId: `doc-lexical-${input.query}`,
              title: input.query,
              content: "recovery",
              similarity: 0.8,
            },
          ];
        },
      },
    );

    const baseInput = {
      request: {
        workspaceId: "w1",
        query: "recover account access",
        history: [],
      },
      settings: {
        workspaceId: "w1",
        queryRewriteEnabled: true,
        semanticRewriteInstructions: "",
        lexicalRewriteInstructions: "",
        answerSupportPolicy: "strict" as const,
        suggestedQuestionsEnabled: true,
        suggestedQuestionsCount: 3,
        rerankEnabled: false,
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
        originalQuery: "recover account access",
        semanticQuery: "recover account access",
        lexicalQuery: "recover account access",
        constraints: [],
      },
      originalPreparedQuery: {
        originalQuery: "recover account access",
        semanticQuery: "recover account access",
        lexicalQuery: "recover account access",
        constraints: [],
      },
      rewrittenQuery: {
        originalQuery: "recover account access",
        rewrittenQuery: "recover account access",
        effectiveQuery: "recover account access",
        semanticQuery: "recover account access",
        lexicalQuery: "recover account access",
        responseIntent: "retrieval" as const,
        retrievalSubqueries: [
          { id: "subquery_1", label: "forgot password", semanticQuery: "account recovery", lexicalQuery: '"forgot password"' },
          { id: "subquery_2", label: "reset token", semanticQuery: "account recovery", lexicalQuery: '"reset token"' },
        ],
        rewriteApplied: true,
        retrievalEligible: true,
        status: "applied" as const,
        confidence: 0.9,
      },
      responseIntent: "retrieval" as const,
      activeQuery: "recover account access",
      activeParsedQuery: {
        originalQuery: "recover account access",
        semanticQuery: "recover account access",
        lexicalQuery: "recover account access",
        constraints: [],
      },
      activeSemanticQuery: "recover account access",
      activeRetrievalSubqueries: [
        { id: "subquery_1", label: "forgot password", semanticQuery: "account recovery", lexicalQuery: '"forgot password"' },
        {
          id: "subquery_2",
          label: "reset token",
          semanticQuery: "account recovery",
          lexicalQuery: '"reset token"',
          lexicalPlan: {
            options: [
              {
                label: "reset token",
                lexicalQuery: '"reset token"',
                phrases: ["reset token"],
                requiredTerms: [],
                excludedTerms: [],
              },
            ],
          },
        },
      ],
      triggerAnalysis: {
        status: "skipped_not_configured" as const,
        consideredRules: [],
        matchedRuleIds: [],
        unmatchedRuleIds: [],
        matchCount: 0,
        matcherVersion: "test",
      },
      promptHistory: [],
      continuityDecision: "updated" as const,
    };

    const result = await stage.execute(baseInput);

    expect(embeddedTexts).toEqual([["account recovery"]]);
    expect(vectorQueries).toEqual([1]);
    expect(lexicalQueries).toEqual(['"forgot password"', '"reset token"']);
    expect(lexicalPlans).toEqual([
      undefined,
      {
        options: [
          {
            label: "reset token",
            lexicalQuery: '"reset token"',
            phrases: ["reset token"],
            requiredTerms: [],
            excludedTerms: [],
          },
        ],
      },
    ]);
    expect(result.retrievalBranches).toHaveLength(2);
    expect(result.rewrittenContexts).toHaveLength(2);
  });
});
