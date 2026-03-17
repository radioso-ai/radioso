import { describe, expect, it } from "vitest";

import type { MessageRecord } from "../../src/db/repositories/messageRepository.js";
import { CandidatePreparationService } from "../../src/modules/retrieval/services/candidatePreparationService.js";
import { ConversationContextService } from "../../src/modules/retrieval/services/conversationContextService.js";
import { OpenAISemanticRerankGateway } from "../../src/modules/retrieval/services/rerankService.js";
import { PromptBuilder } from "../../src/modules/retrieval/services/promptBuilder.js";
import { PromptContextSelectorService } from "../../src/modules/retrieval/services/promptContextSelectorService.js";
import { OpenAIQueryRewriteGateway, QueryRewriteService } from "../../src/modules/retrieval/services/queryRewriteService.js";
import { RerankService } from "../../src/modules/retrieval/services/rerankService.js";

const message = (content: string, role: MessageRecord["role"] = "user"): MessageRecord => ({
  id: content,
  conversationId: "c1",
  workspaceId: "a1",
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

  it("passes literal-only carry-forward values through the context window", () => {
    const service = new ConversationContextService();

    const result = service.select({
      query: "how much is it?",
      history: [
        message("who is Narayani?"),
      ],
      rewriteCarryForwardLiterals: ["Narayani", "La mia anima ricorda Swami Kriyananda", "Ananda Edizioni"],
    });

    expect(result.rewriteCarryForwardLiterals).toEqual([
      "Narayani",
      "La mia anima ricorda Swami Kriyananda",
      "Ananda Edizioni",
    ]);
  });

  it("rewrites referential queries when enabled and context exists", async () => {
    const service = new QueryRewriteService({
      async rewrite(input) {
        return {
          rewrittenQuery: `session cookie usage ${input.query}`,
          turnKind: "referential_followup",
          proposedActiveSubject: "session cookie",
          relatedEntities: [],
          unresolved: false,
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
    expect(result.structuredResult?.proposedActiveSubject).toBe("session cookie");
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
    expect(result.rewriteApplied).toBe(false);
  });

  it("allows unresolved rewrites to run rewritten retrieval", async () => {
    const service = new QueryRewriteService({
      async rewrite() {
        return {
          rewrittenQuery: "Does Narayani work with Arudra?",
          turnKind: "ambiguous",
          proposedActiveSubject: "Narayani",
          relatedEntities: ["Arudra"],
          unresolved: true,
          confidence: 0.7,
        };
      },
    });

    const result = await service.rewrite({
      query: "Does she work with Arudra?",
      enabled: true,
      contextWindow: {
        selectedMessages: [message("Who is Narayani?")],
        truncated: false,
        selectionReason: "full-history",
      },
    });

    expect(result.status).toBe("applied");
    expect(result.retrievalEligible).toBe(true);
    expect(result.rejectionReason).toBeUndefined();
    expect(result.effectiveQuery).toBe("Does Narayani work with Arudra?");
  });

  it("allows unresolved single-subject followups to run rewritten retrieval", async () => {
    const service = new QueryRewriteService({
      async rewrite() {
        return {
          rewrittenQuery: "Can I buy Narayani's book La mia anima ricorda Swami Kriyananda?",
          turnKind: "referential_followup",
          proposedActiveSubject: "Narayani",
          relatedEntities: [],
          unresolved: true,
          confidence: 0.6,
        };
      },
    });

    const result = await service.rewrite({
      query: "Can I buy her book?",
      enabled: true,
      contextWindow: {
        selectedMessages: [
          message("Who is Narayani?"),
          message("Narayani wrote La mia anima ricorda Swami Kriyananda", "assistant"),
        ],
        truncated: false,
        selectionReason: "full-history",
      },
    });

    expect(result.status).toBe("applied");
    expect(result.retrievalEligible).toBe(true);
    expect(result.effectiveQuery).toContain("Narayani");
  });

  it("allows rewritten retrieval even when subject metadata is weakly grounded", async () => {
    const service = new QueryRewriteService({
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
    });

    const result = await service.rewrite({
      query: "What about her later work?",
      enabled: true,
      contextWindow: {
        selectedMessages: [message("Who is Narayani?")],
        truncated: false,
        selectionReason: "full-history",
      },
    });

    expect(result.status).toBe("applied");
    expect(result.retrievalEligible).toBe(true);
    expect(result.effectiveQuery).toBe("What did Arudra publish later?");
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
      lexical: [],
    });

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      chunkId: "c1",
      retrievalSources: ["semantic_original", "semantic_rewritten"],
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
          retrievalSources: ["semantic_original"],
          retrievalText: "A nothing relevant",
          semanticScore: 0.9,
          lexicalScore: 0,
        },
        {
          chunkId: "c2",
          documentId: "d2",
          title: "B",
          content: "this test page explains behavior",
          similarity: 0.3,
          retrievalSources: ["semantic_rewritten"],
          retrievalText: "B this test page explains behavior",
          semanticScore: 0.3,
          lexicalScore: 0,
        },
      ],
    });

    expect(result.status).toBe("applied");
    expect(result.contexts).toHaveLength(1);
    expect(result.contexts[0]?.chunkId).toBe("c2");
  });

  it("uses enriched retrieval text when building rerank candidates", async () => {
    let prompt = "";
    let createInput:
      | {
          messages: Array<{ content: string }>;
          temperature?: number;
          max_completion_tokens?: number;
          model: string;
        }
      | undefined;
    const gateway = new OpenAISemanticRerankGateway(
      {
        chat: {
          completions: {
            create: async (input: {
              messages: Array<{ content: string }>;
              temperature?: number;
              max_completion_tokens?: number;
              model: string;
            }) => {
              createInput = input;
              prompt = input.messages[1]?.content ?? "";
              return {
                choices: [
                  {
                    message: {
                      content: "[]",
                    },
                  },
                ],
              };
            },
          },
        },
      } as never,
      "gpt-test",
    );

    await gateway.rerank({
      query: "summer retreat",
      contexts: [
        {
          chunkId: "c1",
          documentId: "d1",
          title: "Summer Retreat",
          content: "RAW BODY CONTENT SHOULD NOT BE USED",
          similarity: 0.7,
          retrievalSources: ["semantic_original"],
          retrievalText: "Title: Summer Retreat | Dates: 2026-06-12 to 2026-06-15 | Location: Estonia",
          semanticScore: 0.7,
          lexicalScore: 0.3,
        },
      ],
    });

    expect(prompt).toContain("Title: Summer Retreat | Dates: 2026-06-12 to 2026-06-15 | Location: Estonia");
    expect(prompt).not.toContain("RAW BODY CONTENT SHOULD NOT BE USED");
    expect(createInput).toMatchObject({
      model: "gpt-test",
      temperature: 0.2,
      max_completion_tokens: 100,
    });
  });

  it("does not send temperature in rewrite requests", async () => {
    let createInput:
      | {
          messages: Array<{ content: string }>;
          temperature?: number;
          model: string;
        }
      | undefined;
    const gateway = new OpenAIQueryRewriteGateway(
      {
        chat: {
          completions: {
            create: async (input: {
              messages: Array<{ content: string }>;
              temperature?: number;
              model: string;
            }) => {
              createInput = input;
              return {
                choices: [
                  {
                    message: {
                      content:
                        "{\"rewrittenQuery\":\"Can I buy Narayani's book?\",\"turnKind\":\"referential_followup\",\"proposedActiveSubject\":\"Narayani\",\"relatedEntities\":[],\"unresolved\":false,\"confidence\":0.8}",
                    },
                  },
                ],
              };
            },
          },
        },
      } as never,
      "gpt-5-mini",
    );

    await gateway.rewrite({
      query: "Can I buy her book?",
      contextMessages: [
        message("who is Narayani?"),
        message("Narayani wrote La mia anima ricorda Swami Kriyananda", "assistant"),
      ],
      carryForwardLiterals: ["Narayani", "La mia anima ricorda Swami Kriyananda"],
    });

    expect(createInput?.model).toBe("gpt-5-mini");
    expect(createInput).not.toHaveProperty("temperature");
    expect(createInput?.messages[0]?.content).toContain(
      "Do not replace concrete referents with abstract descriptions of prior turns.",
    );
    expect(createInput?.messages[0]?.content).toContain(
      "Do not broaden the query into extra subtopics, checklists, or suggested facets",
    );
    expect(createInput?.messages[1]?.content).toContain(
      "Grounded carry-forward literals from the immediately previous assistant answer",
    );
    expect(createInput?.messages[1]?.content).toContain("[\"Narayani\",\"La mia anima ricorda Swami Kriyananda\"]");
  });

  it("uses valid rerank scores even when some score rows are malformed", async () => {
    const service = new RerankService({
      async rerank() {
        return [
          { chunkId: "c1", relevanceScore: 0.3 },
          { chunkId: "c2", relevanceScore: Number.NaN },
        ];
      },
    });

    const result = await service.rerank({
      query: "rate limit",
      enabled: true,
      topK: 2,
      contexts: [
        {
          chunkId: "c1",
          documentId: "d1",
          title: "Rate Limits",
          content: "The API allows 60 requests per minute.",
          similarity: 0.4,
          retrievalSources: ["semantic_original"],
          retrievalText: "Rate Limits The API allows 60 requests per minute.",
          semanticScore: 0.4,
          lexicalScore: 0,
        },
        {
          chunkId: "c2",
          documentId: "d2",
          title: "Troubleshooting",
          content: "If no context is found, check the threshold.",
          similarity: 0.9,
          retrievalSources: ["semantic_original"],
          retrievalText: "Troubleshooting If no context is found, check the threshold.",
          semanticScore: 0.9,
          lexicalScore: 0,
        },
      ],
    });

    expect(result.status).toBe("applied");
    expect(result.contexts[0]?.chunkId).toBe("c1");
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
          retrievalSources: ["semantic_original"],
          retrievalText: "A short content",
          semanticScore: 0.8,
          lexicalScore: 0,
          relevanceScore: 0.9,
          rerankPosition: 0,
        },
        {
          chunkId: "c2",
          documentId: "d2",
          title: "B",
          content: "x".repeat(400),
          similarity: 0.7,
          retrievalSources: ["semantic_original"],
          retrievalText: "B large content",
          semanticScore: 0.7,
          lexicalScore: 0,
          relevanceScore: 0.8,
          rerankPosition: 1,
        },
      ],
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.chunkId).toBe("c1");
  });

  it("skips an over-budget first chunk and keeps later chunks that fit", () => {
    const service = new PromptContextSelectorService(20);

    const result = service.select({
      topK: 5,
      contexts: [
        {
          chunkId: "c1",
          documentId: "d1",
          title: "A",
          content: "x".repeat(200),
          similarity: 0.95,
          retrievalSources: ["semantic_original"],
          retrievalText: "A oversized content",
          semanticScore: 0.95,
          lexicalScore: 0,
          relevanceScore: 0.99,
          rerankPosition: 0,
        },
        {
          chunkId: "c2",
          documentId: "d2",
          title: "B",
          content: "fits",
          similarity: 0.8,
          retrievalSources: ["semantic_original"],
          retrievalText: "B fits",
          semanticScore: 0.8,
          lexicalScore: 0,
          relevanceScore: 0.85,
          rerankPosition: 1,
        },
      ],
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.chunkId).toBe("c2");
  });

  it("builds prompts with contexts and citations", () => {
    const builder = new PromptBuilder();
    const result = builder.build({
      query: "What does the page do?",
      history: [],
      settings: {
        warmthLevel: 9,
      },
      contexts: [
        {
          chunkId: "c1",
          documentId: "d1",
          title: "Intro",
          content: "The page parses content.",
          similarity: 0.8,
          retrievalSources: ["semantic_original"],
          retrievalText: "Intro The page parses content.",
          semanticScore: 0.8,
          lexicalScore: 0,
          relevanceScore: 0.9,
          rerankPosition: 0,
          promptPosition: 0,
          estimatedTokenCost: 5,
        },
      ],
    });

    expect(result.prompt).toContain("The page parses content.");
    expect(result.prompt).toContain("warm");
    expect(result.prompt).toContain("Do not end the answer with a question");
    expect(result.prompt).toContain("Result 1 (Intro):");
    expect(result.prompt).toContain("[[1]]");
    expect(result.citations).toEqual([{ documentId: "d1", chunkId: "c1", title: "Intro" }]);
  });
});
