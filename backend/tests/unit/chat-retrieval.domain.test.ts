import { describe, expect, it } from "vitest";

import type { MessageRecord } from "../../src/db/repositories/messageRepository.js";
import type { RetrievedCandidate, RetrievalSource } from "../../src/modules/retrieval/domain/retrievalPipelineTypes.js";
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

  it("passes rewrite continuity state through the context window", () => {
    const service = new ConversationContextService();

    const result = service.select({
      query: "how much is it?",
      history: [
        message("who is Narayani?"),
      ],
      rewriteContinuityState: {
        activeSubject: "Narayani",
        relatedEntities: ["La mia anima ricorda Swami Kriyananda"],
        groundedTitles: ["Ananda Edizioni"],
      },
    });

    expect(result.rewriteContinuityState).toEqual({
      activeSubject: "Narayani",
      relatedEntities: ["La mia anima ricorda Swami Kriyananda"],
      groundedTitles: ["Ananda Edizioni"],
    });
  });

  it("keeps prior history when history fits inside the context window", () => {
    const service = new ConversationContextService();

    const history = [
      message("Who is Narayani?"),
      message("Narayani wrote a book", "assistant"),
    ];

    const result = service.select({
      query: "What about her later work?",
      history,
      rewriteContinuityState: {
        activeSubject: "Narayani",
        relatedEntities: [],
        groundedTitles: [],
      },
    });

    expect(result.selectedMessages).toEqual(history);
    expect(result.selectionReason).toBe("full-history");
    expect(result.rewriteContinuityState).toEqual({
      activeSubject: "Narayani",
      relatedEntities: [],
      groundedTitles: [],
    });
  });

  it("expands the history window when continuity tracks multiple grounded entities", () => {
    const service = new ConversationContextService();

    const result = service.select({
      query: "Which one is cheaper?",
      history: [
        message("turn-1"),
        message("turn-2"),
        message("turn-3"),
        message("turn-4"),
        message("turn-5"),
        message("turn-6"),
      ],
      rewriteContinuityState: {
        activeSubject: "Summer Retreat Estonia",
        relatedEntities: ["Summer Retreat Latvia"],
        groundedTitles: ["Summer Retreat Estonia", "Summer Retreat Latvia"],
      },
    });

    expect(result.truncated).toBe(false);
    expect(result.selectionReason).toBe("full-history");
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

  it("falls back to the original query when first-turn rewrite introduces excessive drift", async () => {
    const service = new QueryRewriteService({
      async rewrite() {
        return {
          rewrittenQuery: "Identify who or what Narayani refers to as a person, deity, title, or concept.",
          semanticQuery: "Identify who or what Narayani refers to as a person, deity, title, or concept.",
          lexicalQuery: 'Narayani "who is Narayani"',
          turnKind: "fresh_subject",
          proposedActiveSubject: "Narayani",
          relatedEntities: [],
          unresolved: false,
          confidence: 0.6,
        };
      },
    });

    const result = await service.rewrite({
      query: "Who is Narayani?",
      enabled: true,
      contextWindow: {
        selectedMessages: [],
        truncated: false,
        selectionReason: "no-history",
      },
    });

    expect(result.status).toBe("fallback");
    expect(result.semanticQuery).toBe("Who is Narayani?");
    expect(result.lexicalQuery).toBe("Who is Narayani?");
    expect(result.rewriteApplied).toBe(false);
  });

  it("keeps lexical rewrite close to the original on first-turn queries", async () => {
    const service = new QueryRewriteService({
      async rewrite() {
        return {
          rewrittenQuery: "Who is Narayani?",
          semanticQuery: "Who is Narayani?",
          lexicalQuery: "Narayani Swami Kriyananda Ananda Europe Jayadev Shurjo",
          turnKind: "fresh_subject",
          proposedActiveSubject: "Narayani",
          relatedEntities: [],
          unresolved: false,
          confidence: 0.7,
        };
      },
    });

    const result = await service.rewrite({
      query: "Who is Narayani?",
      enabled: true,
      contextWindow: {
        selectedMessages: [],
        truncated: false,
        selectionReason: "no-history",
      },
    });

    expect(result.lexicalQuery).toBe("Who is Narayani?");
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

  it("allows later batches to surface when reranking large candidate sets", async () => {
    const service = new RerankService({
      async rerank(input) {
        return input.contexts.map((context) => ({
          chunkId: context.chunkId,
          relevanceScore: context.chunkId === "c25" ? 0.99 : 0.01,
        }));
      },
    });

    const contexts: RetrievedCandidate[] = Array.from({ length: 25 }, (_, index) => ({
      chunkId: `c${index + 1}`,
      documentId: `d${index + 1}`,
      title: `Doc ${index + 1}`,
      content: `content ${index + 1}`,
      similarity: 1 - index / 100,
      retrievalSources: ["semantic_original" satisfies RetrievalSource],
      retrievalText: `Doc ${index + 1} content ${index + 1}`,
      semanticScore: 1 - index / 100,
      lexicalScore: 0,
    }));

    const result = await service.rerank({
      query: "target",
      enabled: true,
      topK: 1,
      contexts,
    });

    expect(result.status).toBe("applied");
    expect(result.contexts[0]?.chunkId).toBe("c25");
  });

  it("parses OpenAI rerank JSON object responses", async () => {
    const gateway = new OpenAISemanticRerankGateway(
      {
        responses: {
          async create() {
            return {
              output_text: JSON.stringify({
                scores: [
                  { candidateIndex: 2, relevanceScore: 0.9 },
                  { candidateIndex: 1, relevanceScore: 0.2 },
                ],
              }),
            };
          },
        },
      } as never,
      "gpt-5.2",
    );

    const result = await gateway.rerank({
      query: "Who is Narayani?",
      contexts: [
        { chunkId: "a", documentId: "d1", title: "A", content: "", retrievalText: "A", similarity: 0.2 },
        { chunkId: "b", documentId: "d2", title: "B", content: "", retrievalText: "B", similarity: 0.1 },
      ] as never,
    });

    expect(result).toEqual([
      { chunkId: "b", relevanceScore: 0.9 },
      { chunkId: "a", relevanceScore: 0.2 },
    ]);
  });

  it("uses enriched retrieval text when building rerank candidates", async () => {
    let prompt = "";
    let createInput:
      | {
          temperature?: number;
          max_output_tokens?: number;
          model: string;
          instructions?: string;
          input?: string;
          text?: {
            format?: {
              type: "json_schema";
              name: string;
              strict?: boolean | null;
              schema: Record<string, unknown>;
            };
          };
        }
      | undefined;
    const gateway = new OpenAISemanticRerankGateway(
      {
        responses: {
          create: async (input: {
            temperature?: number;
            max_output_tokens?: number;
            model: string;
            instructions?: string;
            input?: string;
            text?: {
              format?: {
                type: "json_schema";
                name: string;
                strict?: boolean | null;
                schema: Record<string, unknown>;
              };
            };
          }) => {
            createInput = input;
            prompt = input.input ?? "";
            return {
              output_text: '{"scores":[]}',
            };
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
    expect(prompt).toContain("1. c1 |");
    expect(prompt).not.toContain("RAW BODY CONTENT SHOULD NOT BE USED");
    expect(createInput).toMatchObject({
      model: "gpt-test",
      temperature: 0.2,
      max_output_tokens: 200,
      text: {
        format: {
          type: "json_schema",
          name: "rerank_scores",
        },
      },
    });

    expect(createInput?.max_output_tokens).toBe(200);
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
      continuityState: {
        activeSubject: "Narayani",
        relatedEntities: ["La mia anima ricorda Swami Kriyananda"],
        groundedTitles: [],
      },
    });

    expect(createInput?.model).toBe("gpt-5-mini");
    expect(createInput).not.toHaveProperty("temperature");
    expect(createInput?.messages[0]?.content).toContain(
      "Do not replace concrete referents with abstract descriptions of prior turns.",
    );
    expect(createInput?.messages[0]?.content).toContain(
      "Do not broaden the query into extra subtopics, checklists, or suggested facets",
    );
    expect(createInput?.messages[0]?.content).toContain(
      'For continuation-only follow-ups such as "teach me more", "tell me more", "go on", "continue", "say more", or "more please"',
    );
    expect(createInput?.messages[1]?.content).toContain(
      "Retrieval continuity state from the most recent successful assistant turn",
    );
    expect(createInput?.messages[1]?.content).toContain("\"activeSubject\":\"Narayani\"");
  });

  it("accepts continuation rewrites that stay anchored to the previous user topic", async () => {
    const service = new QueryRewriteService({
      async rewrite() {
        return {
          rewrittenQuery: "teach me more about yoga",
          semanticQuery: "teach me more about yoga",
          lexicalQuery: "yoga",
          turnKind: "referential_followup",
          proposedActiveSubject: "yoga",
          relatedEntities: [],
          unresolved: false,
          confidence: 0.84,
        };
      },
    });

    const result = await service.rewrite({
      query: "teach me more",
      enabled: true,
      contextWindow: {
        selectedMessages: [
          message("yoga"),
          message(
            "Yoga can be a body practice, a breath practice, or a path toward inner calm. I can also help with routines, gear, or recordings.",
            "assistant",
          ),
        ],
        truncated: false,
        selectionReason: "full-history",
      },
    });

    expect(result.status).toBe("applied");
    expect(result.retrievalEligible).toBe(true);
    expect(result.semanticQuery).toBe("teach me more about yoga");
    expect(result.lexicalQuery).toBe("yoga");
    expect(result.structuredResult?.proposedActiveSubject).toBe("yoga");
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

  it("skips near-duplicate contexts so later distinct chunks can fit", () => {
    const service = new PromptContextSelectorService(200);

    const result = service.select({
      topK: 4,
      contexts: [
        {
          chunkId: "c1",
          documentId: "d1",
          title: "Calendar A",
          content: "Hosted by Ananda Assisi. Joy is within you. Zoom satsang details and registration.",
          similarity: 0.95,
          retrievalSources: ["lexical"],
          retrievalText: "Calendar A Hosted by Ananda Assisi. Joy is within you. Zoom satsang details and registration.",
          semanticScore: 0,
          lexicalScore: 0.95,
          relevanceScore: 0.95,
          rerankPosition: 0,
        },
        {
          chunkId: "c2",
          documentId: "d2",
          title: "Calendar B",
          content: "Hosted by Ananda Assisi. Joy is within you. Zoom satsang details and registration.",
          similarity: 0.94,
          retrievalSources: ["lexical"],
          retrievalText: "Calendar B Hosted by Ananda Assisi. Joy is within you. Zoom satsang details and registration.",
          semanticScore: 0,
          lexicalScore: 0.94,
          relevanceScore: 0.94,
          rerankPosition: 1,
        },
        {
          chunkId: "c3",
          documentId: "d3",
          title: "Narayani",
          content: "Narayani is originally from Spain and later became Swami Kriyananda's assistant.",
          similarity: 0.7,
          retrievalSources: ["semantic_original"],
          retrievalText: "Narayani is originally from Spain and later became Swami Kriyananda's assistant.",
          semanticScore: 0.7,
          lexicalScore: 0,
          relevanceScore: 0.7,
          rerankPosition: 2,
        },
      ],
    });

    expect(result).toHaveLength(2);
    expect(result.map((context) => context.chunkId)).toEqual(["c1", "c3"]);
  });

  it("keeps chunks that share an opening prefix but diverge later", () => {
    const selector = new PromptContextSelectorService(200);

    const sharedPrefix = "Event header and boilerplate introduction ".repeat(6);
    const result = selector.select({
      topK: 3,
      contexts: [
        {
          chunkId: "c1",
          documentId: "d1",
          title: "A",
          content: `${sharedPrefix} unique ending alpha`,
          similarity: 0.9,
          relevanceScore: 0.9,
          retrievalSources: ["semantic_original"],
          retrievalText: "A",
          semanticScore: 0.9,
          lexicalScore: 0,
          rerankPosition: 0,
        },
        {
          chunkId: "c2",
          documentId: "d2",
          title: "B",
          content: `${sharedPrefix} unique ending beta`,
          similarity: 0.8,
          relevanceScore: 0.8,
          retrievalSources: ["semantic_original"],
          retrievalText: "B",
          semanticScore: 0.8,
          lexicalScore: 0,
          rerankPosition: 1,
        },
      ],
    });

    expect(result.map((context) => context.chunkId)).toEqual(["c1", "c2"]);
  });

  it("builds prompts with contexts and citations", () => {
    const builder = new PromptBuilder();
    const result = builder.build({
      query: "What does the page do?",
      history: [],
      settings: {
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
    expect(result.prompt).not.toContain("Warmth:");
    expect(result.prompt).toContain("Respond in the same language as the current user question.");
    expect(result.prompt).toContain("Do not end the answer with a question");
    expect(result.prompt).toContain("embed it inline as a Markdown link with descriptive link text");
    expect(result.prompt).toContain("Result 1 (Intro):");
    expect(result.prompt).toContain("[[1]]");
    expect(result.citations).toEqual([{ documentId: "d1", chunkId: "c1", title: "Intro" }]);
  });

  it("includes a Source line in the prompt when context has a sourceUrl in metadata", () => {
    const builder = new PromptBuilder();
    const result = builder.build({
      query: "What is this about?",
      history: [],
      settings: {
      },
      contexts: [
        {
          chunkId: "c1",
          documentId: "d1",
          title: "External Doc",
          content: "Some content from an external source.",
          similarity: 0.9,
          retrievalSources: ["semantic_original"],
          retrievalText: "External Doc Some content from an external source.",
          semanticScore: 0.9,
          lexicalScore: 0,
          relevanceScore: 0.9,
          rerankPosition: 0,
          promptPosition: 0,
          estimatedTokenCost: 10,
          metadata: { sourceUrl: "https://example.com/doc" },
        },
      ],
    });

    expect(result.prompt).toContain("Source: https://example.com/doc");
  });

  it("does not include a Source line in the prompt when context has no sourceUrl", () => {
    const builder = new PromptBuilder();
    const result = builder.build({
      query: "What is this about?",
      history: [],
      settings: {
      },
      contexts: [
        {
          chunkId: "c2",
          documentId: "d2",
          title: "Internal Doc",
          content: "Some content without a source URL.",
          similarity: 0.8,
          retrievalSources: ["semantic_original"],
          retrievalText: "Internal Doc Some content without a source URL.",
          semanticScore: 0.8,
          lexicalScore: 0,
          relevanceScore: 0.85,
          rerankPosition: 0,
          promptPosition: 0,
          estimatedTokenCost: 8,
        },
      ],
    });

    expect(result.prompt).not.toContain("Source:");
  });

  it("includes custom instruction block in prompt when customInstruction is non-empty", () => {
    const builder = new PromptBuilder();
    const result = builder.build({
      query: "What are the work permit requirements?",
      history: [],
      settings: {
        customInstruction: "Always cite the paragraph number from the Immigration Act.",
      },
      contexts: [],
    });

    expect(result.prompt).toContain("Workspace-specific instructions:");
    expect(result.prompt).toContain("Always cite the paragraph number from the Immigration Act.");
  });

  it("omits custom instruction block when customInstruction is empty", () => {
    const builder = new PromptBuilder();
    const result = builder.build({
      query: "What are the work permit requirements?",
      history: [],
      settings: {
        customInstruction: "",
      },
      contexts: [],
    });

    expect(result.prompt).not.toContain("Workspace-specific instructions:");
  });

  it("sanitizes control characters from customInstruction but preserves newlines and tabs", () => {
    const builder = new PromptBuilder();
    const result = builder.build({
      query: "test",
      history: [],
      settings: {
        customInstruction: "Line one\nLine two\tTabbed\x00Null\x01Control",
      },
      contexts: [],
    });

    expect(result.prompt).toContain("Line one\nLine two\tTabbed");
    expect(result.prompt).not.toContain("\x00");
    expect(result.prompt).not.toContain("\x01");
  });

  it("includes guided conversation-mode instructions in the prompt", () => {
    const builder = new PromptBuilder();
    const result = builder.build({
      query: "What does the page explain?",
      history: [],
      settings: {
        conversationMode: "guided",
      },
      contexts: [],
    });

    expect(result.prompt).toContain("Conversation mode: guided.");
    expect(result.prompt).toContain("Answer the user's question directly and concisely.");
    expect(result.prompt).toContain(
      "Do not append suggested next questions or adjacent directions in the answer body; those are surfaced separately when available.",
    );
    expect(result.prompt).toContain(
      'Do not append suggested next questions, adjacent topics, or "you could also ask" lists after the answer; those are surfaced separately in the product UI.',
    );
  });

  it("includes exploratory conversation-mode instructions in the prompt", () => {
    const builder = new PromptBuilder();
    const result = builder.build({
      query: "What else can I explore?",
      history: [],
      settings: {
        conversationMode: "exploratory",
      },
      contexts: [],
    });

    expect(result.prompt).toContain("Conversation mode: exploratory.");
    expect(result.prompt).toContain("Answer the user's question directly, and stay grounded in the retrieved material.");
    expect(result.prompt).toContain(
      "Do not append suggested next questions or adjacent directions in the answer body; those are surfaced separately when available.",
    );
  });
});
