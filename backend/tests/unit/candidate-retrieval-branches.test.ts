import { describe, expect, it } from "vitest";

import { CandidateRetrievalStageService } from "../../src/modules/retrieval/services/candidateRetrievalStage.js";
import { EmbeddingService } from "../../src/modules/retrieval/services/embeddingService.js";

describe("candidate retrieval branches", () => {
  it("runs semantic and lexical retrieval separately for each active subquery", async () => {
    const vectorQueries: number[] = [];
    const lexicalQueries: string[] = [];
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
        answerSupportPolicy: "strict",
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
});
