import { describe, expect, it } from "vitest";

import { CandidateRetrievalStageService } from "../../src/modules/retrieval/services/candidateRetrievalStage.js";

const embeddingSpace = { id: "space-active", dimensions: 1, distanceMetric: "cosine" as const };

const hydrateSemanticCandidates = {
  async hydrate(input: {
    candidates: Array<{ chunkId: string; documentId?: string; score: number }>;
  }) {
    return input.candidates.map((candidate) => ({
      chunkId: candidate.chunkId,
      documentId: candidate.documentId ?? `doc-${candidate.chunkId}`,
      title: candidate.chunkId,
      content: "profile",
      similarity: candidate.score,
    }));
  },
};

describe("candidate retrieval branches", () => {
  it("runs semantic and lexical retrieval separately for each active subquery", async () => {
    const vectorQueries: number[] = [];
    const lexicalQueries: string[] = [];
    const lexicalPlans: unknown[] = [];
    const stage = new CandidateRetrievalStageService(
      {
        async embedQueries(input) {
          return { space: embeddingSpace, vectors: input.texts.map((_, index) => [index + 1]) };
        },
      },
      {
        async search(input) {
          vectorQueries.push(Number(input.queryVector[0]));
          return [
            {
              chunkId: `semantic-${input.queryVector[0]}`,
              documentId: `doc-semantic-${input.queryVector[0]}`,
              embeddingSpaceId: input.space.id,
              version: "1",
              score: 0.9,
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
      hydrateSemanticCandidates,
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
        retrievalSubqueries: [
          { id: "subquery_1", label: "Narayani", semanticQuery: "who is narayani", lexicalQuery: "narayani" },
          { id: "subquery_2", label: "Arudra", semanticQuery: "who is arudra", lexicalQuery: "arudra" },
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
      promptHistoryReset: false,
      continuityDecision: "updated",
    });

    expect(vectorQueries).toEqual([1, 2]);
    expect(lexicalQueries).toEqual(["narayani", "arudra"]);
    expect(result.retrievalBranches).toHaveLength(2);
    expect(result.retrievalBranches.map((branch) => branch.label)).toEqual(["Narayani", "Arudra"]);
    expect(result.rewrittenContexts).toHaveLength(2);
    expect(result.lexicalContexts).toHaveLength(2);
  });

  it("caps distinct semantic searches while still running every lexical branch", async () => {
    const embeddedTexts: string[][] = [];
    const vectorQueries: number[] = [];
    const lexicalQueries: string[] = [];
    const stage = new CandidateRetrievalStageService(
      {
        async embedQueries(input) {
          embeddedTexts.push([...input.texts]);
          return { space: embeddingSpace, vectors: input.texts.map((_, index) => [index + 1]) };
        },
      },
      {
        async search(input) {
          vectorQueries.push(Number(input.queryVector[0]));
          return [
            {
              chunkId: `semantic-${input.queryVector[0]}`,
              documentId: `doc-semantic-${input.queryVector[0]}`,
              embeddingSpaceId: input.space.id,
              version: "1",
              score: 0.9,
            },
          ];
        },
      },
      {
        async search(input) {
          lexicalQueries.push(input.query);
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
      hydrateSemanticCandidates,
    );

    const subqueries = [
      { id: "subquery_1", label: "Alpha", semanticQuery: "who is alpha", lexicalQuery: "alpha" },
      { id: "subquery_2", label: "Beta", semanticQuery: "who is beta", lexicalQuery: "beta" },
      { id: "subquery_3", label: "Gamma", semanticQuery: "who is gamma", lexicalQuery: "gamma" },
      { id: "subquery_4", label: "Delta", semanticQuery: "who is delta", lexicalQuery: "delta" },
    ];

    const result = await stage.execute({
      request: {
        workspaceId: "w1",
        query: "alpha beta gamma delta?",
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
        originalQuery: "alpha beta gamma delta?",
        semanticQuery: "alpha beta gamma delta?",
        lexicalQuery: "alpha beta gamma delta?",
        constraints: [],
      },
      originalPreparedQuery: {
        originalQuery: "alpha beta gamma delta?",
        semanticQuery: "alpha beta gamma delta?",
        lexicalQuery: "alpha beta gamma delta?",
        constraints: [],
      },
      rewrittenQuery: {
        originalQuery: "alpha beta gamma delta?",
        rewrittenQuery: "alpha beta gamma delta?",
        effectiveQuery: "alpha beta gamma delta?",
        semanticQuery: "alpha beta gamma delta?",
        lexicalQuery: "alpha beta gamma delta?",
        retrievalSubqueries: subqueries,
        rewriteApplied: true,
        retrievalEligible: true,
        status: "applied",
        confidence: 0.9,
      },
      activeQuery: "alpha beta gamma delta?",
      activeParsedQuery: {
        originalQuery: "alpha beta gamma delta?",
        semanticQuery: "alpha beta gamma delta?",
        lexicalQuery: "alpha beta gamma delta?",
        constraints: [],
      },
      activeSemanticQuery: "alpha beta gamma delta?",
      activeRetrievalSubqueries: subqueries,
      triggerAnalysis: {
        status: "skipped_not_configured",
        consideredRules: [],
        matchedRuleIds: [],
        unmatchedRuleIds: [],
        matchCount: 0,
        matcherVersion: "test",
      },
      promptHistory: [],
      promptHistoryReset: false,
      continuityDecision: "updated",
    });

    // Semantic is the expensive side: only the first two distinct queries embed and search.
    expect(embeddedTexts).toEqual([["who is alpha", "who is beta"]]);
    expect(vectorQueries).toEqual([1, 2]);
    // Lexical is cheap: every branch still runs its own lexical search.
    expect(lexicalQueries).toEqual(["alpha", "beta", "gamma", "delta"]);
    expect(result.retrievalBranches).toHaveLength(4);
    expect(result.lexicalContexts).toHaveLength(4);
    // The two overflow branches contribute lexical-only (no extra semantic searches).
    expect(result.rewrittenContexts).toHaveLength(2);
    expect(result.retrievalBranches[2]?.semanticContexts).toEqual([]);
    expect(result.retrievalBranches[3]?.semanticContexts).toEqual([]);
  });

  it("passes the query embedding port's opaque active space through semantic search", async () => {
    const seenEmbeddingInputs: Array<{ workspaceId: string; texts: readonly string[] }> = [];
    const seenVectorInputs: Array<{ spaceId: string; vector: number[] }> = [];
    const seenHydrationInputs: Array<{ candidateIds: string[] }> = [];
    const space = { id: "space-active", dimensions: 2, distanceMetric: "cosine" as const };
    const stage = new CandidateRetrievalStageService(
      {
        async embedQueries(input) {
          seenEmbeddingInputs.push(input);
          return { space, vectors: input.texts.map(() => [1, 2]) };
        },
      },
      {
        async search(input) {
          seenVectorInputs.push({
            spaceId: input.space.id,
            vector: input.queryVector,
          });
          return [{
            chunkId: "chunk-1",
            documentId: "doc-1",
            embeddingSpaceId: input.space.id,
            version: "1",
            score: 0.9,
          }];
        },
      },
      {
        async search() {
          return [];
        },
      },
      {
        async hydrate(input) {
          seenHydrationInputs.push({
            candidateIds: input.candidates.map((candidate) => candidate.chunkId),
          });
          return [{
            chunkId: "chunk-1",
            documentId: "doc-1",
            title: "Account recovery",
            content: "Recovery content",
            similarity: input.candidates[0]?.score ?? 0,
          }];
        },
      },
    );

    const result = await stage.execute({
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
        retrievalSubqueries: [
          { id: "subquery_1", label: "account recovery", semanticQuery: "account recovery", lexicalQuery: "account recovery" },
        ],
        rewriteApplied: true,
        retrievalEligible: true,
        status: "applied",
        confidence: 0.9,
      },
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
      promptHistoryReset: false,
      continuityDecision: "updated",
    });

    expect(seenEmbeddingInputs).toEqual([expect.objectContaining({
      workspaceId: "w1",
      texts: ["account recovery"],
    })]);
    expect(seenVectorInputs).toEqual([{ spaceId: "space-active", vector: [1, 2] }]);
    expect(seenHydrationInputs).toEqual([{ candidateIds: ["chunk-1"] }]);
    expect(result.rewrittenContexts).toEqual([
      {
        chunkId: "chunk-1",
        documentId: "doc-1",
        title: "Account recovery",
        content: "Recovery content",
        similarity: 0.9,
      },
    ]);
  });

  it("reuses identical semantic retrieval while still running distinct lexical branches", async () => {
    const embeddedTexts: string[][] = [];
    const vectorQueries: number[] = [];
    const lexicalQueries: string[] = [];
    const lexicalPlans: unknown[] = [];
    const stage = new CandidateRetrievalStageService(
      {
        async embedQueries(input) {
          embeddedTexts.push([...input.texts]);
          return { space: embeddingSpace, vectors: input.texts.map((_, index) => [index + 1]) };
        },
      },
      {
        async search(input) {
          vectorQueries.push(Number(input.queryVector[0]));
          return [
            {
              chunkId: `semantic-${input.queryVector[0]}`,
              documentId: `doc-semantic-${input.queryVector[0]}`,
              embeddingSpaceId: input.space.id,
              version: "1",
              score: 0.9,
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
      hydrateSemanticCandidates,
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
        retrievalSubqueries: [
          { id: "subquery_1", label: "forgot password", semanticQuery: "account recovery", lexicalQuery: '"forgot password"' },
          { id: "subquery_2", label: "reset token", semanticQuery: "account recovery", lexicalQuery: '"reset token"' },
        ],
        rewriteApplied: true,
        retrievalEligible: true,
        status: "applied" as const,
        confidence: 0.9,
      },
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
      promptHistoryReset: false,
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
