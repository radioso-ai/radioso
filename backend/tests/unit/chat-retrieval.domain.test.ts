import { describe, expect, it } from "vitest";

import type { MessageRecord } from "../../src/db/repositories/messageRepository.js";
import { CandidatePreparationService } from "../../src/modules/retrieval/services/candidatePreparationService.js";
import { ConversationContextService } from "../../src/modules/retrieval/services/conversationContextService.js";
import { PromptBuilder } from "../../src/modules/retrieval/services/promptBuilder.js";
import { PromptContextSelectorService } from "../../src/modules/retrieval/services/promptContextSelectorService.js";
import { QueryRewriteService } from "../../src/modules/retrieval/services/queryRewriteService.js";
import { RerankService } from "../../src/modules/retrieval/services/rerankService.js";

const message = (content: string, role: MessageRecord["role"] = "user"): MessageRecord => ({
  id: content,
  conversationId: "c1",
  accountId: "a1",
  role,
  content,
  createdAt: new Date(),
});

describe("chat retrieval domain", () => {
  it("selects a bounded recent conversation window", () => {
    const service = new ConversationContextService();

    const result = service.select({
      query: "What is it used for?",
      history: [
        message("first"),
        message("second"),
        message("third"),
        message("fourth"),
        message("fifth"),
      ],
    });

    expect(result.truncated).toBe(true);
    expect(result.selectedMessages).toHaveLength(4);
    expect(result.selectedMessages[0]?.content).toBe("second");
  });

  it("rewrites referential queries when enabled and context exists", async () => {
    const service = new QueryRewriteService({
      async rewrite(input) {
        return {
          rewrittenQuery: `session cookie usage ${input.query}`,
          confidence: 0.9,
        };
      },
    });

    const result = await service.rewrite({
      query: "What is it used for?",
      enabled: true,
      contextWindow: {
        selectedMessages: [message("Tell me about the session cookie")],
        truncated: false,
        selectionReason: "full-history",
      },
    });

    expect(result.status).toBe("applied");
    expect(result.effectiveQuery).toContain("session cookie");
    expect(result.originalQuery).toBe("What is it used for?");
  });

  it("falls back to the original query when rewrite fails", async () => {
    const service = new QueryRewriteService({
      async rewrite() {
        throw new Error("boom");
      },
    });

    const result = await service.rewrite({
      query: "What is it used for?",
      enabled: true,
      contextWindow: {
        selectedMessages: [message("Tell me about the session cookie")],
        truncated: false,
        selectionReason: "full-history",
      },
    });

    expect(result.status).toBe("fallback");
    expect(result.effectiveQuery).toBe("What is it used for?");
  });

  it("deduplicates candidates across original and rewritten retrieval paths", () => {
    const service = new CandidatePreparationService();

    const result = service.prepare({
      original: [
        { chunkId: "c1", documentId: "d1", title: "A", content: "rate limit", similarity: 0.6 },
        { chunkId: "c2", documentId: "d2", title: "B", content: "session cookie", similarity: 0.4 },
      ],
      rewritten: [
        { chunkId: "c1", documentId: "d1", title: "A", content: "rate limit", similarity: 0.9 },
      ],
    });

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      chunkId: "c1",
      retrievalSources: ["original", "rewritten"],
      similarity: 0.9,
    });
  });

  it("reranks contexts semantically when enabled", async () => {
    const service = new RerankService({
      async rerank() {
        return [
          { chunkId: "c1", relevanceScore: 0.1 },
          { chunkId: "c2", relevanceScore: 0.95 },
        ];
      },
    });

    const result = await service.rerank({
      query: "test page",
      enabled: true,
      topK: 1,
      contexts: [
        {
          chunkId: "c1",
          documentId: "d1",
          title: "A",
          content: "nothing relevant",
          similarity: 0.9,
          retrievalSources: ["original"],
          retrievalText: "A nothing relevant",
        },
        {
          chunkId: "c2",
          documentId: "d2",
          title: "B",
          content: "this test page explains behavior",
          similarity: 0.3,
          retrievalSources: ["rewritten"],
          retrievalText: "B this test page explains behavior",
        },
      ],
    });

    expect(result.status).toBe("applied");
    expect(result.contexts).toHaveLength(1);
    expect(result.contexts[0]?.chunkId).toBe("c2");
  });

  it("limits final prompt contexts by token budget", () => {
    const service = new PromptContextSelectorService(20);

    const result = service.select({
      topK: 5,
      contexts: [
        {
          chunkId: "c1",
          documentId: "d1",
          title: "A",
          content: "short content",
          similarity: 0.8,
          retrievalSources: ["original"],
          retrievalText: "A short content",
          relevanceScore: 0.9,
          rerankPosition: 0,
        },
        {
          chunkId: "c2",
          documentId: "d2",
          title: "B",
          content: "x".repeat(400),
          similarity: 0.7,
          retrievalSources: ["original"],
          retrievalText: "B large content",
          relevanceScore: 0.8,
          rerankPosition: 1,
        },
      ],
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.chunkId).toBe("c1");
  });

  it("builds prompts with contexts and citations", () => {
    const builder = new PromptBuilder();
    const result = builder.build({
      query: "What does the page do?",
      history: [],
      contexts: [
        {
          chunkId: "c1",
          documentId: "d1",
          title: "Intro",
          content: "The page parses content.",
          similarity: 0.8,
          retrievalSources: ["original"],
          retrievalText: "Intro The page parses content.",
          relevanceScore: 0.9,
          rerankPosition: 0,
          promptPosition: 0,
          estimatedTokenCost: 5,
        },
      ],
    });

    expect(result.prompt).toContain("The page parses content.");
    expect(result.citations).toEqual([{ documentId: "d1", chunkId: "c1", title: "Intro" }]);
  });
});
