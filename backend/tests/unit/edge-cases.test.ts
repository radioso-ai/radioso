import { describe, expect, it } from "vitest";

import { chunkMarkdown, normalizeMarkdown } from "../../src/modules/retrieval/domain/chunkingService.js";
import { QueryRewriteService } from "../../src/modules/retrieval/services/queryRewriteService.js";
import { PromptBuilder } from "../../src/modules/retrieval/services/promptBuilder.js";
import { RerankService } from "../../src/modules/retrieval/services/rerankService.js";
import { RetrievalPipelineService } from "../../src/modules/retrieval/services/retrievalPipelineService.js";
import { CandidatePreparationService } from "../../src/modules/retrieval/services/candidatePreparationService.js";
import { ConversationContextService } from "../../src/modules/retrieval/services/conversationContextService.js";
import { PromptContextSelectorService } from "../../src/modules/retrieval/services/promptContextSelectorService.js";
import { RetrievalExecutionTelemetryService } from "../../src/modules/retrieval/services/retrievalExecutionTelemetryService.js";

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
            accountId: "a1",
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
    expect(result.effectiveQuery).toBe("What is the session cookie used for?");
  });

  it("does not heuristic-rewrite a standalone short query against prior context", async () => {
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
            accountId: "a1",
            role: "user",
            content: "Tell me about the session cookie",
            createdAt: new Date(),
          },
        ],
        truncated: false,
        selectionReason: "full-history",
      },
    });

    expect(result.status).toBe("skipped");
    expect(result.effectiveQuery).toBe("What is the API rate limit?");
    expect(result.rewriteApplied).toBe(false);
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
          retrievalSources: ["original"],
          retrievalText: "Rate Limits The API allows 60 requests per minute.",
        },
        {
          chunkId: "c2",
          documentId: "d2",
          title: "Troubleshooting",
          content: "If no context is found, check the threshold.",
          similarity: 0.1,
          retrievalSources: ["rewritten"],
          retrievalText: "Troubleshooting If no context is found, check the threshold.",
        },
      ],
    });

    expect(result.status).toBe("fallback");
    expect(result.contexts[0]?.chunkId).toBe("c1");
  });

  it("relaxes strict retrieval thresholds when first-pass search returns no candidates", async () => {
    const thresholdsSeen: number[] = [];
    const service = new RetrievalPipelineService(
      {
        async getForAccount() {
          return {
            accountId: "a1",
            queryRewriteEnabled: false,
            rerankEnabled: false,
            vectorTopK: 100,
            similarityThreshold: 0.8,
            rerankTopK: 20,
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
      new ConversationContextService(),
      new QueryRewriteService(),
      new CandidatePreparationService(),
      new RerankService(),
      new PromptContextSelectorService(),
      new PromptBuilder(),
      new RetrievalExecutionTelemetryService(),
    );

    const result = await service.run({
      accountId: "a1",
      query: "What is the API rate limit?",
      history: [],
    });

    expect(thresholdsSeen).toContain(0.8);
    expect(thresholdsSeen.some((value) => value < 0.8)).toBe(true);
    expect(result.contexts).toHaveLength(1);
    expect(result.diagnostics.candidateFallbackApplied).toBe(true);
    expect(result.diagnostics.fallbackApplied).toBe(true);
  });
});
