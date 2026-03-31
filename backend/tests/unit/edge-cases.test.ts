import { describe, expect, it } from "vitest";

import { chunkMarkdown, normalizeMarkdown } from "../../src/modules/retrieval/domain/chunkingService.js";
import { QueryRewriteService } from "../../src/modules/retrieval/services/queryRewriteService.js";
import { AttributeMatchScoringService } from "../../src/modules/retrieval/services/attributeMatchScoringService.js";
import { PromptBuilder } from "../../src/modules/retrieval/services/promptBuilder.js";
import { RerankService } from "../../src/modules/retrieval/services/rerankService.js";
import { RetrievalPipelineService } from "../../src/modules/retrieval/services/retrievalPipelineService.js";
import { CandidatePreparationService } from "../../src/modules/retrieval/services/candidatePreparationService.js";
import { ConversationContextService } from "../../src/modules/retrieval/services/conversationContextService.js";
import { PromptContextSelectorService } from "../../src/modules/retrieval/services/promptContextSelectorService.js";
import { RetrievalExecutionTelemetryService } from "../../src/modules/retrieval/services/retrievalExecutionTelemetryService.js";
import { defaultAttributeControls } from "../../src/modules/settings/domain/retrievalSettings.js";

describe("edge cases", () => {
  it("normalizes short content into a single chunk", () => {
    const content = "   short content   ";
    const normalized = normalizeMarkdown(content);
    const chunks = chunkMarkdown(content);

    expect(normalized).toBe("short content");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe("short content");
  });

  it("builds a prompt safely when no context is retrieved", () => {
    const builder = new PromptBuilder();
    const result = builder.build({
      query: "What happened?",
      history: [],
      settings: {
        warmthLevel: 5,
      },
      contexts: [],
    });

    expect(result.prompt).toContain("No retrieved context");
    expect(result.citations).toEqual([]);
  });

  it("falls back to the original query when rewrite assistance errors", async () => {
    const service = new QueryRewriteService({
      async rewrite() {
        throw new Error("rewrite unavailable");
      },
    });

    const result = await service.rewrite({
      query: "What is it used for?",
      enabled: true,
      contextWindow: {
        selectedMessages: [
          {
            id: "1",
            conversationId: "c1",
            workspaceId: "a1",
            role: "user",
            content: "Tell me about the session cookie",
            createdAt: new Date(),
          },
        ],
        truncated: false,
        selectionReason: "full-history",
      },
    });

    expect(result.status).toBe("fallback");
    expect(result.effectiveQuery).toBe("What is it used for?");
    expect(result.lexicalQuery).toBe("What is it used for?");
  });

  it("falls back when contextual rewrite assistance fails for a standalone query", async () => {
    const service = new QueryRewriteService({
      async rewrite() {
        throw new Error("rewrite unavailable");
      },
    });

    const result = await service.rewrite({
      query: "What is the API rate limit?",
      enabled: true,
      contextWindow: {
        selectedMessages: [
          {
            id: "1",
            conversationId: "c1",
            workspaceId: "a1",
            role: "user",
            content: "Tell me about the session cookie",
            createdAt: new Date(),
          },
        ],
        truncated: false,
        selectionReason: "full-history",
      },
    });

    expect(result.status).toBe("fallback");
    expect(result.effectiveQuery).toBe("What is the API rate limit?");
    expect(result.rewriteApplied).toBe(false);
    expect(result.semanticQuery).toBe("What is the API rate limit?");
    expect(result.lexicalQuery).toBe("What is the API rate limit?");
  });

  it("falls back to similarity ordering when rerank assistance errors", async () => {
    const service = new RerankService({
      async rerank() {
        throw new Error("rerank unavailable");
      },
    });

    const result = await service.rerank({
      query: "rate limit",
      enabled: true,
      topK: 1,
      contexts: [
        {
          chunkId: "c1",
          documentId: "d1",
          title: "Rate Limits",
          content: "The API allows 60 requests per minute.",
          similarity: 0.9,
          retrievalSources: ["semantic_original"],
          retrievalText: "Rate Limits The API allows 60 requests per minute.",
          semanticScore: 0.9,
          lexicalScore: 0,
        },
        {
          chunkId: "c2",
          documentId: "d2",
          title: "Troubleshooting",
          content: "If no context is found, check the threshold.",
          similarity: 0.1,
          retrievalSources: ["semantic_rewritten"],
          retrievalText: "Troubleshooting If no context is found, check the threshold.",
          semanticScore: 0.1,
          lexicalScore: 0,
        },
      ],
    });

    expect(result.status).toBe("fallback");
    expect(result.contexts[0]?.chunkId).toBe("c1");
  });

  it("keeps the configured retrieval threshold when first-pass search returns no candidates", async () => {
    const thresholdsSeen: number[] = [];
    const service = new RetrievalPipelineService(
      {
        async getForWorkspace() {
          return {
            workspaceId: "a1",
            queryRewriteEnabled: false,
            rerankEnabled: false,
            vectorTopK: 100,
            similarityThreshold: 0.8,
            rerankTopK: 20,
            warmthLevel: 5,
            citationDisplayEnabled: true,
            signalPolicies: defaultAttributeControls(),
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        },
      } as never,
      {
        async embedChunks() {
          return [[1, 0, 0]];
        },
      } as never,
      {
        async search(input) {
          thresholdsSeen.push(input.similarityThreshold);
          if (input.similarityThreshold >= 0.8) {
            return [];
          }
          return [
            {
              chunkId: "c1",
              documentId: "d1",
              title: "Rate Limits",
              content: "The API allows 60 requests per minute.",
              similarity: 0.61,
            },
          ];
        },
      },
      {
        async search() {
          return [];
        },
      },
      new ConversationContextService(),
      new QueryRewriteService(),
      new CandidatePreparationService(),
      new AttributeMatchScoringService(),
      new RerankService(),
      new PromptContextSelectorService(),
      new PromptBuilder(),
      new RetrievalExecutionTelemetryService(),
    );

    const result = await service.run({
      workspaceId: "a1",
      query: "What is the API rate limit?",
      history: [],
    });

    expect(thresholdsSeen).toEqual([0.8]);
    expect(result.contexts).toHaveLength(0);
    expect(result.diagnostics.candidateFallbackApplied).toBe(false);
    expect(result.diagnostics.fallbackApplied).toBe(false);
  });

  it("keeps disabled attribute literals in semantic and lexical queries", async () => {
    const embeddedQueries: string[] = [];
    const lexicalQueries: string[] = [];
    const service = new RetrievalPipelineService(
      {
        async getForWorkspace() {
          return {
            workspaceId: "a1",
            queryRewriteEnabled: false,
            rerankEnabled: false,
            vectorTopK: 20,
            similarityThreshold: 0.2,
            rerankTopK: 5,
            warmthLevel: 5,
            citationDisplayEnabled: true,
            signalPolicies: defaultAttributeControls().map((control) =>
              control.signalKey === "document_location" || control.signalKey === "document_amount"
                ? { ...control, enabled: false }
                : control,
            ),
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        },
      } as never,
      {
        async embedChunks(chunks: string[]) {
          embeddedQueries.push(...chunks);
          return chunks.map(() => [1, 0, 0]);
        },
      } as never,
      {
        async search() {
          return [];
        },
      },
      {
        async search(input) {
          lexicalQueries.push(input.query);
          return [];
        },
      },
      new ConversationContextService(),
      new QueryRewriteService(),
      new CandidatePreparationService(),
      new AttributeMatchScoringService(),
      new RerankService(),
      new PromptContextSelectorService(),
      new PromptBuilder(),
      new RetrievalExecutionTelemetryService(),
    );

    const result = await service.run({
      workspaceId: "a1",
      query: "Find retreats in Estonia under 300 EUR",
      history: [],
    });

    expect(embeddedQueries).toEqual(["retreats in Estonia under 300 EUR"]);
    expect(lexicalQueries).toEqual(["retreats in Estonia under 300 EUR"]);
    expect(result.diagnostics.parsedQuery?.semanticQuery).toBe("retreats in Estonia under 300 EUR");
    expect(result.diagnostics.appliedConstraints).toEqual([
      {
        signalKey: "document_location",
        mode: "boost_only",
        outcome: "skipped",
        summary: "in Estonia",
      },
      {
        signalKey: "document_amount",
        mode: "boost_only",
        outcome: "skipped",
        summary: "under 300 EUR",
      },
    ]);
  });

  it("keeps boost_only attribute literals before semantic and lexical retrieval", async () => {
    const embeddedQueries: string[] = [];
    const lexicalQueries: string[] = [];
    const service = new RetrievalPipelineService(
      {
        async getForWorkspace() {
          return {
            workspaceId: "a1",
            queryRewriteEnabled: false,
            rerankEnabled: false,
            vectorTopK: 20,
            similarityThreshold: 0.2,
            rerankTopK: 5,
            warmthLevel: 5,
            citationDisplayEnabled: true,
            signalPolicies: defaultAttributeControls(),
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        },
      } as never,
      {
        async embedChunks(chunks: string[]) {
          embeddedQueries.push(...chunks);
          return chunks.map(() => [1, 0, 0]);
        },
      } as never,
      {
        async search() {
          return [];
        },
      },
      {
        async search(input) {
          lexicalQueries.push(input.query);
          return [];
        },
      },
      new ConversationContextService(),
      new QueryRewriteService(),
      new CandidatePreparationService(),
      new AttributeMatchScoringService(),
      new RerankService(),
      new PromptContextSelectorService(),
      new PromptBuilder(),
      new RetrievalExecutionTelemetryService(),
    );

    const result = await service.run({
      workspaceId: "a1",
      query: "Find retreats in Estonia under 300 EUR",
      history: [],
    });

    expect(embeddedQueries).toEqual(["retreats in Estonia under 300 EUR"]);
    expect(lexicalQueries).toEqual(["retreats in Estonia under 300 EUR"]);
    expect(result.diagnostics.parsedQuery?.semanticQuery).toBe("retreats in Estonia under 300 EUR");
  });

  it("strips hard_filter attribute literals before semantic and lexical retrieval", async () => {
    const embeddedQueries: string[] = [];
    const lexicalQueries: string[] = [];
    const service = new RetrievalPipelineService(
      {
        async getForWorkspace() {
          return {
            workspaceId: "a1",
            queryRewriteEnabled: false,
            rerankEnabled: false,
            vectorTopK: 20,
            similarityThreshold: 0.2,
            rerankTopK: 5,
            warmthLevel: 5,
            citationDisplayEnabled: true,
            signalPolicies: defaultAttributeControls().map((control) =>
              control.signalKey === "document_location" || control.signalKey === "document_amount"
                ? { ...control, mode: "hard_filter" as const }
                : control,
            ),
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        },
      } as never,
      {
        async embedChunks(chunks: string[]) {
          embeddedQueries.push(...chunks);
          return chunks.map(() => [1, 0, 0]);
        },
      } as never,
      {
        async search() {
          return [];
        },
      },
      {
        async search(input) {
          lexicalQueries.push(input.query);
          return [];
        },
      },
      new ConversationContextService(),
      new QueryRewriteService(),
      new CandidatePreparationService(),
      new AttributeMatchScoringService(),
      new RerankService(),
      new PromptContextSelectorService(),
      new PromptBuilder(),
      new RetrievalExecutionTelemetryService(),
    );

    const result = await service.run({
      workspaceId: "a1",
      query: "Find retreats in Estonia under 300 EUR",
      history: [],
    });

    expect(embeddedQueries).toEqual(["retreats"]);
    expect(lexicalQueries).toEqual(["retreats"]);
    expect(result.diagnostics.parsedQuery?.semanticQuery).toBe("retreats");
  });

  it("preserves original constraints when rewrite omits structured literals", async () => {
    const service = new RetrievalPipelineService(
      {
        async getForWorkspace() {
          return {
            workspaceId: "a1",
            queryRewriteEnabled: true,
            rerankEnabled: false,
            vectorTopK: 20,
            similarityThreshold: 0.2,
            rerankTopK: 5,
            warmthLevel: 5,
            citationDisplayEnabled: true,
            signalPolicies: defaultAttributeControls(),
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        },
      } as never,
      {
        async embedChunks() {
          return [[1, 0, 0]];
        },
      } as never,
      {
        async search() {
          return [
            {
              chunkId: "c1",
              documentId: "d1",
              title: "Summer Retreat",
              content: "Summer retreat in Estonia costs 290 EUR.",
              similarity: 0.6,
              structuredAttributes: {
                datePoints: [],
                dateRanges: [],
                moneyValues: [
                  {
                    amount: 290,
                    currencyCode: "EUR",
                    confidence: 0.95,
                    sourceText: "290 EUR",
                  },
                ],
                locations: [],
              },
            },
          ];
        },
      },
      {
        async search() {
          return [];
        },
      },
      new ConversationContextService(),
      new QueryRewriteService({
        async rewrite() {
          return {
            rewrittenQuery: "summer retreat pricing",
            turnKind: "referential_followup",
            proposedActiveSubject: "summer retreat",
            relatedEntities: [],
            unresolved: false,
            confidence: 0.9,
          };
        },
      }),
      new CandidatePreparationService(),
      new AttributeMatchScoringService(),
      new RerankService(),
      new PromptContextSelectorService(),
      new PromptBuilder(),
      new RetrievalExecutionTelemetryService(),
    );

    const result = await service.run({
      workspaceId: "a1",
      query: "Is it under 300 EUR?",
      history: [
        {
          id: "1",
          conversationId: "c1",
          workspaceId: "a1",
          role: "user",
          content: "Tell me about the summer retreat",
          createdAt: new Date(),
        },
      ],
    });

    expect(result.rewrittenQuery).toBe("summer retreat pricing");
    expect(result.diagnostics.parsedQuery?.semanticQuery).toBe("summer retreat pricing");
    expect(result.diagnostics.parsedQuery?.constraints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          signalKey: "document_amount",
          operator: "lte",
          summary: "under 300 EUR",
        }),
      ]),
    );
    expect(result.diagnostics.appliedConstraints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          signalKey: "document_amount",
          outcome: "applied",
        }),
      ]),
    );
  });

  it("drops rewritten retrieval candidates when rewrite evidence materially disagrees", async () => {
    const embeddedQueries: string[] = [];
    const service = new RetrievalPipelineService(
      {
        async getForWorkspace() {
          return {
            workspaceId: "a1",
            queryRewriteEnabled: true,
            rerankEnabled: false,
            vectorTopK: 20,
            similarityThreshold: 0.2,
            rerankTopK: 5,
            warmthLevel: 5,
            citationDisplayEnabled: true,
            signalPolicies: defaultAttributeControls(),
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        },
      } as never,
      {
        async embedChunks(chunks: string[]) {
          embeddedQueries.push(...chunks);
          return chunks.map(() => [1, 0, 0]);
        },
      } as never,
      {
        async search(input) {
          if ((input.queryEmbedding[0] ?? 0) > 25) {
            return [
              {
                chunkId: "c2",
                documentId: "d2",
                title: "Arudra",
                content: "Arudra later work.",
                similarity: 0.9,
              },
            ];
          }

          return [
            {
              chunkId: "c1",
              documentId: "d1",
              title: "Narayani",
              content: "Narayani later work.",
              similarity: 0.8,
            },
          ];
        },
      },
      {
        async search() {
          return [];
        },
      },
      new ConversationContextService(),
      new QueryRewriteService({
        async rewrite() {
          return {
            rewrittenQuery: "What did Arudra publish later?",
            turnKind: "referential_followup",
            proposedActiveSubject: "Arudra",
            relatedEntities: [],
            unresolved: false,
            confidence: 0.9,
          };
        },
      }),
      new CandidatePreparationService(),
      new AttributeMatchScoringService(),
      new RerankService(),
      new PromptContextSelectorService(),
      new PromptBuilder(),
      new RetrievalExecutionTelemetryService(),
    );

    const result = await service.run({
      workspaceId: "a1",
      query: "What about her later work?",
      history: [
        {
          id: "1",
          conversationId: "c1",
          workspaceId: "a1",
          role: "user",
          content: "Who is Narayani?",
          createdAt: new Date(),
        },
      ],
    });

    expect(result.rewrittenQuery).toBe("What did Arudra publish later?");
    expect(result.diagnostics.materialDisagreement).toBe(false);
    expect(result.diagnostics.rejectionReason).toBeUndefined();
    expect(result.contexts[0]?.title).toBe("Narayani");
    expect(embeddedQueries).toEqual(["What did Arudra publish later?"]);
  });

  it("rejects a subject switch when raw retrieval only mentions the rewritten subject incidentally", async () => {
    const service = new RetrievalPipelineService(
      {
        async getForWorkspace() {
          return {
            workspaceId: "a1",
            queryRewriteEnabled: true,
            rerankEnabled: false,
            vectorTopK: 20,
            similarityThreshold: 0.2,
            rerankTopK: 5,
            warmthLevel: 5,
            citationDisplayEnabled: true,
            signalPolicies: defaultAttributeControls(),
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        },
      } as never,
      {
        async embedChunks(chunks: string[]) {
          return chunks.map((chunk) => [chunk.toLowerCase().includes("arudra") ? 1 : 0, 0, 0]);
        },
      } as never,
      {
        async search(input) {
          if ((input.queryEmbedding[0] ?? 0) === 1) {
            return [
              {
                chunkId: "c2",
                documentId: "d2",
                title: "Arudra",
                content: "Arudra later work and publications.",
                similarity: 0.95,
              },
            ];
          }

          return [
            {
              chunkId: "c1",
              documentId: "d1",
              title: "Narayani",
              content: "Narayani sometimes collaborates with Arudra on events.",
              similarity: 0.75,
            },
          ];
        },
      },
      {
        async search() {
          return [];
        },
      },
      new ConversationContextService(),
      new QueryRewriteService({
        async rewrite() {
          return {
            rewrittenQuery: "What did Arudra publish later?",
            turnKind: "referential_followup",
            proposedActiveSubject: "Arudra",
            relatedEntities: [],
            unresolved: false,
            confidence: 0.95,
          };
        },
      }),
      new CandidatePreparationService(),
      new AttributeMatchScoringService(),
      new RerankService(),
      new PromptContextSelectorService(),
      new PromptBuilder(),
      new RetrievalExecutionTelemetryService(),
    );

    const result = await service.run({
      workspaceId: "a1",
      query: "What about her later work?",
      history: [
        {
          id: "1",
          conversationId: "c1",
          workspaceId: "a1",
          role: "user",
          content: "Who is Narayani, and does she collaborate with Arudra?",
          createdAt: new Date(),
        },
        {
          id: "2",
          conversationId: "c1",
          workspaceId: "a1",
          role: "assistant",
          content: "Narayani sometimes collaborates with Arudra.",
          createdAt: new Date(),
        },
      ],
    });

    expect(result.rewrittenQuery).toBe("What did Arudra publish later?");
    expect(result.diagnostics.materialDisagreement).toBe(false);
    expect(result.diagnostics.rejectionReason).toBeUndefined();
    expect(result.diagnostics.rewrittenCandidateCount).toBe(1);
  });

  it("preserves unresolved continuity decisions for blocked rewrites", async () => {
    const service = new RetrievalPipelineService(
      {
        async getForWorkspace() {
          return {
            workspaceId: "a1",
            queryRewriteEnabled: true,
            rerankEnabled: false,
            vectorTopK: 20,
            similarityThreshold: 0.2,
            rerankTopK: 5,
            warmthLevel: 5,
            citationDisplayEnabled: true,
            signalPolicies: defaultAttributeControls(),
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        },
      } as never,
      {
        async embedChunks() {
          return [[1, 0, 0]];
        },
      } as never,
      {
        async search() {
          return [];
        },
      },
      {
        async search() {
          return [];
        },
      },
      new ConversationContextService(),
      new QueryRewriteService({
        async rewrite() {
          return {
            rewrittenQuery: "Does Narayani work with Arudra?",
            turnKind: "referential_relation",
            proposedActiveSubject: "Narayani",
            relatedEntities: ["Arudra"],
            unresolved: true,
            confidence: 0.78,
          };
        },
      }),
      new CandidatePreparationService(),
      new AttributeMatchScoringService(),
      new RerankService(),
      new PromptContextSelectorService(),
      new PromptBuilder(),
      new RetrievalExecutionTelemetryService(),
    );

    const result = await service.run({
      workspaceId: "a1",
      query: "Does she work with Arudra?",
      history: [
        {
          id: "1",
          conversationId: "c1",
          workspaceId: "a1",
          role: "user",
          content: "Who is Narayani?",
          createdAt: new Date(),
        },
      ],
    });

    expect(result.diagnostics.rewriteStatus).toBe("applied");
    expect(result.diagnostics.continuityDecision).toBe("unresolved");
    expect(result.diagnostics.rejectionReason).toBeUndefined();
  });

  it("allows rewritten retrieval even when subject metadata only appears in assistant text", async () => {
    const service = new QueryRewriteService({
      async rewrite() {
        return {
          rewrittenQuery: "What did Arudra publish later?",
          turnKind: "referential_followup",
          proposedActiveSubject: "Arudra",
          relatedEntities: [],
          unresolved: false,
          confidence: 0.78,
        };
      },
    });

    const result = await service.rewrite({
      query: "What about her later work?",
      enabled: true,
      contextWindow: {
        selectedMessages: [
          {
            id: "1",
            conversationId: "c1",
            workspaceId: "a1",
            role: "user",
            content: "Who is Narayani?",
            createdAt: new Date(),
          },
          {
            id: "2",
            conversationId: "c1",
            workspaceId: "a1",
            role: "assistant",
            content: "Narayani sometimes collaborates with Arudra.",
            createdAt: new Date(),
          },
        ],
        truncated: false,
        selectionReason: "full-history",
      },
    });

    expect(result.status).toBe("applied");
    expect(result.retrievalEligible).toBe(true);
    expect(result.effectiveQuery).toBe("What did Arudra publish later?");
  });

  it("rejects rewritten retrieval when the proposed subject is unsupported in rewritten evidence", async () => {
    let searchCallCount = 0;
    const service = new RetrievalPipelineService(
      {
        async getForWorkspace() {
          return {
            workspaceId: "a1",
            queryRewriteEnabled: true,
            rerankEnabled: false,
            vectorTopK: 20,
            similarityThreshold: 0.2,
            rerankTopK: 5,
            warmthLevel: 5,
            citationDisplayEnabled: true,
            signalPolicies: defaultAttributeControls(),
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        },
      } as never,
      {
        async embedChunks() {
          return [[1, 0, 0]];
        },
      } as never,
      {
        async search() {
          searchCallCount += 1;
          if (searchCallCount === 2) {
            return [
              {
                chunkId: "c2",
                documentId: "d2",
                title: "Publication timeline",
                content: "Later publications from the archive are listed chronologically.",
                similarity: 0.88,
              },
            ];
          }

          return [
            {
              chunkId: "c1",
              documentId: "d1",
              title: "Arudra",
              content: "Arudra later work and publications.",
              similarity: 0.81,
            },
          ];
        },
      },
      {
        async search() {
          return [];
        },
      },
      new ConversationContextService(),
      new QueryRewriteService({
        async rewrite() {
          return {
            rewrittenQuery: "What did Arudra publish later?",
            turnKind: "referential_followup",
            proposedActiveSubject: "Arudra",
            relatedEntities: [],
            unresolved: false,
            confidence: 0.93,
          };
        },
      }),
      new CandidatePreparationService(),
      new AttributeMatchScoringService(),
      new RerankService(),
      new PromptContextSelectorService(),
      new PromptBuilder(),
      new RetrievalExecutionTelemetryService(),
    );

    const result = await service.run({
      workspaceId: "a1",
      query: "What about her later work?",
      history: [
        {
          id: "1",
          conversationId: "c1",
          workspaceId: "a1",
          role: "user",
          content: "Who is Narayani, and does she collaborate with Arudra?",
          createdAt: new Date(),
        },
      ],
    });

    expect(result.rewrittenQuery).toBe("What did Arudra publish later?");
    expect(result.diagnostics.materialDisagreement).toBe(false);
    expect(result.diagnostics.rejectionReason).toBeUndefined();
    expect(result.diagnostics.rewrittenCandidateCount).toBe(1);
  });
});
