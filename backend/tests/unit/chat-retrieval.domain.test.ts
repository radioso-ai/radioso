import { describe, expect, it } from "vitest";

import type { MessageRecord } from "../../src/db/repositories/messageRepository.js";
import type { RerankedCandidate, RetrievedCandidate, RetrievalSource } from "../../src/modules/retrieval/domain/retrievalPipelineTypes.js";
import { CandidatePreparationService } from "../../src/modules/retrieval/services/candidatePreparationService.js";
import { ContextSelectionStageService } from "../../src/modules/retrieval/services/contextSelectionStage.js";
import { ConversationContextService } from "../../src/modules/retrieval/services/conversationContextService.js";
import { ModelRerankGateway, OpenAISemanticRerankGateway } from "../../src/modules/retrieval/services/rerankService.js";
import { PromptBuilder } from "../../src/modules/retrieval/services/promptBuilder.js";
import { PromptContextSelectorService } from "../../src/modules/retrieval/services/promptContextSelectorService.js";
import { OpenAIQueryRewriteGateway, QueryRewriteService } from "../../src/modules/retrieval/services/queryRewriteService.js";
import { RerankService } from "../../src/modules/retrieval/services/rerankService.js";
import { RetrievalAnswerService } from "../../src/modules/retrieval/services/retrievalAnswerService.js";
import { RETRIEVAL_BEHAVIOR } from "../../src/shared/domain/behaviorConfig.js";

const message = (content: string, role: MessageRecord["role"] = "user"): MessageRecord => ({
  id: content,
  conversationId: "c1",
  workspaceId: "a1",
  role,
  content,
  createdAt: new Date(),
});

const rerankedCandidate = (input: {
  chunkId: string;
  documentId: string;
  title: string;
  content: string;
  score: number;
  rerankPosition: number;
}): RerankedCandidate => ({
  chunkId: input.chunkId,
  documentId: input.documentId,
  title: input.title,
  content: input.content,
  similarity: input.score,
  retrievalSources: ["semantic_original"],
  retrievalText: `${input.title} ${input.content}`,
  semanticScore: input.score,
  lexicalScore: 0,
  relevanceScore: input.score,
  rerankPosition: input.rerankPosition,
});

describe("chat retrieval domain", () => {
  it("selects a larger bounded recent conversation window for rewrite", () => {
    const service = new ConversationContextService();

    const result = service.select({
      history: [
        message("first"),
        message("second"),
        message("third"),
        message("fourth"),
        message("fifth"),
        message("sixth"),
        message("seventh"),
        message("eighth"),
        message("ninth"),
        message("tenth"),
        message("eleventh"),
        message("twelfth"),
      ],
    });

    expect(result.truncated).toBe(true);
    expect(result.selectedMessages).toHaveLength(10);
    expect(result.selectedMessages[0]?.content).toBe("third");
    expect(result.selectionReason).toBe("recent-window");
  });

  it("keeps prior history when history fits inside the context window", () => {
    const service = new ConversationContextService();

    const history = [
      message("Who is Narayani?"),
      message("Narayani wrote a book", "assistant"),
    ];

    const result = service.select({
      history,
    });

    expect(result.selectedMessages).toEqual(history);
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
    expect(result.responseIntent).toBe("retrieval");
  });

  it("defaults responseIntent to retrieval when older rewrite output omits it", async () => {
    const service = new QueryRewriteService({
      async rewrite() {
        return {
          rewrittenQuery: "What did Arudra publish later?",
          semanticQuery: "What did Arudra publish later?",
          lexicalQuery: "\"Arudra\" later publish",
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
        selectedMessages: [message("Who is Arudra?")],
        truncated: false,
        selectionReason: "full-history",
      },
    });

    expect(result.status).toBe("applied");
    expect(result.retrievalEligible).toBe(true);
    expect(result.responseIntent).toBe("retrieval");
    expect(result.structuredResult?.responseIntent).toBe("retrieval");
  });

  it("keeps social-only intent on a non-retrieval path even when no rewrite is needed", async () => {
    const service = new QueryRewriteService({
      async rewrite() {
        return {
          rewrittenQuery: "Thanks for the help",
          semanticQuery: "Thanks for the help",
          lexicalQuery: "Thanks for the help",
          responseIntent: "social_only" as const,
          turnKind: "ambiguous",
          relatedEntities: [],
          unresolved: false,
          confidence: 0.93,
        };
      },
    });

    const result = await service.rewrite({
      query: "Thanks for the help",
      enabled: true,
      contextWindow: {
        selectedMessages: [message("Tell me about the retreat")],
        truncated: false,
        selectionReason: "full-history",
      },
    });

    expect(result.status).toBe("applied");
    expect(result.retrievalEligible).toBe(false);
    expect(result.responseIntent).toBe("social_only");
    expect(result.effectiveQuery).toBe("Thanks for the help");
    expect(result.fallbackReason).toBeUndefined();
  });

  it("keeps assistant-identity intent on a non-retrieval path even when no rewrite is needed", async () => {
    const service = new QueryRewriteService({
      async rewrite() {
        return {
          rewrittenQuery: "Who are you?",
          semanticQuery: "Who are you?",
          lexicalQuery: "Who are you?",
          responseIntent: "assistant_identity" as const,
          turnKind: "ambiguous",
          relatedEntities: [],
          unresolved: false,
          confidence: 0.9,
        };
      },
    });

    const result = await service.rewrite({
      query: "Who are you?",
      enabled: true,
      contextWindow: {
        selectedMessages: [message("Hi there")],
        truncated: false,
        selectionReason: "full-history",
      },
    });

    expect(result.status).toBe("applied");
    expect(result.retrievalEligible).toBe(false);
    expect(result.responseIntent).toBe("assistant_identity");
    expect(result.fallbackReason).toBeUndefined();
  });

  it("falls back to retrieval when a non-retrieval intent is low confidence", async () => {
    const service = new QueryRewriteService({
      async rewrite() {
        return {
          rewrittenQuery: "Thanks for the help",
          semanticQuery: "Thanks for the help",
          lexicalQuery: "Thanks for the help",
          responseIntent: "social_only" as const,
          turnKind: "ambiguous",
          relatedEntities: [],
          unresolved: false,
          confidence: 0.62,
        };
      },
    });

    const result = await service.rewrite({
      query: "Thanks for the help",
      enabled: true,
      contextWindow: {
        selectedMessages: [],
        truncated: false,
        selectionReason: "no-history",
      },
    });

    expect(result.responseIntent).toBe("retrieval");
    expect(result.intentFallbackApplied).toBe(true);
    expect(result.fallbackReason).toBe("intent_low_confidence");
    expect(result.status).toBe("fallback");
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

  it("maps generic rerank JSON object responses by candidate index", async () => {
    const gateway = new ModelRerankGateway({
      metadata: { capability: "rerank", provider: "openai-compatible", model: "rerank-test" },
      async complete() {
        return JSON.stringify({
          scores: [
            { candidateIndex: 2, relevanceScore: 0.85 },
            { candidateIndex: 1, relevanceScore: 0.15 },
          ],
        });
      },
      async *stream() {
        yield "";
      },
    });

    const result = await gateway.rerank({
      query: "Who is Narayani?",
      contexts: [
        { chunkId: "a", documentId: "d1", title: "A", content: "", retrievalText: "A", similarity: 0.2 },
        { chunkId: "b", documentId: "d2", title: "B", content: "", retrievalText: "B", similarity: 0.1 },
      ] as never,
    });

    expect(result).toEqual([
      { chunkId: "b", relevanceScore: 0.85 },
      { chunkId: "a", relevanceScore: 0.15 },
    ]);
  });

  it("uses enriched retrieval text when building rerank candidates", async () => {
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
    expect(createInput?.messages[0]?.content).toContain(
      "If the immediately previous ASSISTANT turn offered multiple concrete options and the user accepted or asked to continue without choosing one",
    );
    expect(createInput?.messages[0]?.content).toContain('"responseIntent":"retrieval|social_only|assistant_identity"');
    expect(createInput?.messages[0]?.content).toContain(
      'Do not output vague placeholder rewrites such as "continue the current topic", "the previous topic", or "go ahead with that".',
    );
    expect(createInput?.messages[0]?.content).toContain(
      "Do not guess one branch and do not collapse several branches into one bag-of-terms rewrite.",
    );
    expect(createInput?.messages).toHaveLength(1);
    expect(createInput?.messages[0]?.content).not.toContain(
      "Retrieval continuity state from the most recent successful assistant turn",
    );
  });

  it("accepts assistant-offered multi-option continuations through retrieval subqueries", async () => {
    const service = new QueryRewriteService({
      async rewrite() {
        return {
          rewrittenQuery: "go ahead",
          semanticQuery: "go ahead",
          lexicalQuery: "go ahead",
          responseLanguagePolicy: "match_user_question",
          retrievalSubqueries: [
            {
              id: "",
              label: "Ananda courses and retreats",
              semanticQuery: "Ananda courses and retreats",
              lexicalQuery: "\"Ananda courses and retreats\"",
              responseLanguagePolicy: "match_user_question",
            },
            {
              id: "",
              label: "Yogananda's teachings",
              semanticQuery: "Yogananda's teachings",
              lexicalQuery: "\"Yogananda's teachings\"",
              responseLanguagePolicy: "match_user_question",
            },
            {
              id: "",
              label: "meditation or spiritual practice",
              semanticQuery: "meditation or spiritual practice",
              lexicalQuery: "\"meditation\" OR \"spiritual practice\"",
              responseLanguagePolicy: "match_user_question",
            },
          ],
          turnKind: "ambiguous",
          relatedEntities: ["Ananda courses and retreats", "Yogananda's teachings", "meditation or spiritual practice"],
          unresolved: false,
          confidence: 0.83,
        };
      },
    });

    const result = await service.rewrite({
      query: "go ahead",
      enabled: true,
      contextWindow: {
        selectedMessages: [
          message("what is your instruction?"),
          message(
            "I couldn't verify that from your workspace documents, but I did find related material in \"RESIDENTIAL COURSE: Original Teachings of Yogananda - Simple Living and High Thinking\" if you'd like to explore that instead.",
            "assistant",
          ),
        ],
        truncated: false,
        selectionReason: "full-history",
      },
    });

    expect(result.status).toBe("applied");
    expect(result.retrievalEligible).toBe(true);
    expect(result.semanticQuery).toBe("go ahead");
    expect(result.lexicalQuery).toBe("go ahead");
    expect(result.retrievalSubqueries?.map((subquery) => subquery.label)).toEqual([
      "Ananda courses and retreats",
      "Yogananda's teachings",
      "meditation or spiritual practice",
    ]);
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

  it("accepts focused lexical rewrites even when the semantic query stays unchanged", async () => {
    const service = new QueryRewriteService({
      async rewrite() {
        return {
          rewrittenQuery: "tell me about yoga",
          semanticQuery: "tell me about yoga",
          lexicalQuery: "yoga",
          turnKind: "fresh_subject",
          proposedActiveSubject: "yoga",
          relatedEntities: [],
          unresolved: true,
          confidence: 0.93,
        };
      },
    });

    const result = await service.rewrite({
      query: "tell me about yoga",
      enabled: true,
      contextWindow: {
        selectedMessages: [],
        truncated: false,
        selectionReason: "full-history",
      },
    });

    expect(result.status).toBe("applied");
    expect(result.retrievalEligible).toBe(true);
    expect(result.semanticQuery).toBe("tell me about yoga");
    expect(result.lexicalQuery).toBe("yoga");
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

  it("prefers distinct documents before adding sibling chunks to final prompt context", () => {
    const selector = new PromptContextSelectorService(500);

    const result = selector.select({
      topK: 3,
      contexts: [
        rerankedCandidate({
          chunkId: "course-overview-1",
          documentId: "course-overview",
          title: "Kriya Yoga Overview",
          content: "Kriya Yoga overview and preparation details.",
          score: 0.99,
          rerankPosition: 0,
        }),
        rerankedCandidate({
          chunkId: "course-overview-2",
          documentId: "course-overview",
          title: "Kriya Yoga Overview",
          content: "Additional Kriya Yoga overview details from the same page.",
          score: 0.98,
          rerankPosition: 1,
        }),
        rerankedCandidate({
          chunkId: "preparation",
          documentId: "preparation-course",
          title: "Preparation for Kriya Yoga",
          content: "Preparation for Kriya Yoga course path.",
          score: 0.89,
          rerankPosition: 2,
        }),
        rerankedCandidate({
          chunkId: "kriyaban",
          documentId: "kriyaban-course",
          title: "Courses for Kriyaban",
          content: "Courses for Kriyaban deepen the Kriya Yoga practice.",
          score: 0.82,
          rerankPosition: 3,
        }),
      ],
    });

    expect(result.map((context) => context.chunkId)).toEqual([
      "course-overview-1",
      "preparation",
      "kriyaban",
    ]);
  });

  it("treats repeated titles as siblings when selecting prompt context", () => {
    const selector = new PromptContextSelectorService(800);

    const result = selector.select({
      topK: 4,
      contexts: [
        rerankedCandidate({
          chunkId: "event-copy-1",
          documentId: "event-copy-1",
          title: "Yoga to Relieve Stress and Gain Strength",
          content: "Repeated event listing with teacher biography.",
          score: 0.99,
          rerankPosition: 0,
        }),
        rerankedCandidate({
          chunkId: "event-copy-2",
          documentId: "event-copy-2",
          title: "Yoga to Relieve Stress and Gain Strength",
          content: "Second repeated event listing with the same title.",
          score: 0.98,
          rerankPosition: 1,
        }),
        rerankedCandidate({
          chunkId: "ananda-yoga",
          documentId: "ananda-yoga",
          title: "Ananda Yoga",
          content: "Ananda Yoga is an inward practice using postures, breath, and affirmations.",
          score: 0.9,
          rerankPosition: 2,
        }),
        rerankedCandidate({
          chunkId: "course-card",
          documentId: "course-card",
          title: "Residential Course: Yoga and Christianity",
          content: "Course card with dates and booking details.",
          score: 0.85,
          rerankPosition: 3,
        }),
      ],
    });

    expect(result.map((context) => context.chunkId)).toEqual([
      "event-copy-1",
      "ananda-yoga",
      "course-card",
      "event-copy-2",
    ]);
  });

  it("fills from the same document up to the same-document cap when no alternates are available", () => {
    const selector = new PromptContextSelectorService(500);

    const result = selector.select({
      topK: 4,
      contexts: [
        rerankedCandidate({
          chunkId: "overview-1",
          documentId: "overview",
          title: "Kriya Yoga Overview",
          content: "First Kriya Yoga overview section.",
          score: 0.99,
          rerankPosition: 0,
        }),
        rerankedCandidate({
          chunkId: "overview-2",
          documentId: "overview",
          title: "Kriya Yoga Overview",
          content: "Second Kriya Yoga overview section.",
          score: 0.96,
          rerankPosition: 1,
        }),
        rerankedCandidate({
          chunkId: "overview-3",
          documentId: "overview",
          title: "Kriya Yoga Overview",
          content: "Third Kriya Yoga overview section.",
          score: 0.94,
          rerankPosition: 2,
        }),
      ],
    });

    expect(result.map((context) => context.chunkId)).toEqual(["overview-1", "overview-2"]);
  });

  it("caps the candidate set sent to semantic reranking independently from final contexts", async () => {
    let rerankCandidateCount = 0;
    const stage = new ContextSelectionStageService(
      new RerankService({
        async rerank(input) {
          rerankCandidateCount += input.contexts.length;
          return input.contexts.map((context, index) => ({
            chunkId: context.chunkId,
            relevanceScore: 1 - index / 100,
          }));
        },
      }),
      new PromptContextSelectorService(10_000),
    );

    const scoredCandidates: RetrievedCandidate[] = Array.from({ length: 25 }, (_, index) => ({
      chunkId: `c${index + 1}`,
      documentId: `d${index + 1}`,
      title: `Doc ${index + 1}`,
      content: `Useful retrieval content for document ${index + 1}.`,
      similarity: 1 - index / 100,
      retrievalSources: ["semantic_original"],
      retrievalText: `Doc ${index + 1} Useful retrieval content for document ${index + 1}.`,
      semanticScore: 1 - index / 100,
      lexicalScore: 0,
    }));

    const result = await stage.execute({
      settings: {
        rerankEnabled: true,
        rerankTopK: 15,
      },
      activeParsedQuery: {
        semanticQuery: "yoga",
      },
      activeQuery: "yoga",
      scoredCandidates,
    } as never);

    expect(rerankCandidateCount).toBe(15);
    expect(result.contexts).toHaveLength(RETRIEVAL_BEHAVIOR.finalContextTopK);
  });

  it("does not let a low rerank top K shrink the final prompt context cap", async () => {
    let rerankCandidateCount = 0;
    const stage = new ContextSelectionStageService(
      new RerankService({
        async rerank(input) {
          rerankCandidateCount += input.contexts.length;
          return input.contexts.map((context, index) => ({
            chunkId: context.chunkId,
            relevanceScore: 1 - index / 100,
          }));
        },
      }),
      new PromptContextSelectorService(10_000),
    );

    const scoredCandidates: RetrievedCandidate[] = Array.from({ length: 12 }, (_, index) => ({
      chunkId: `c${index + 1}`,
      documentId: `d${index + 1}`,
      title: `Doc ${index + 1}`,
      content: `Useful retrieval content for document ${index + 1}.`,
      similarity: 1 - index / 100,
      retrievalSources: ["semantic_original"],
      retrievalText: `Doc ${index + 1} Useful retrieval content for document ${index + 1}.`,
      semanticScore: 1 - index / 100,
      lexicalScore: 0,
    }));

    const result = await stage.execute({
      settings: {
        rerankEnabled: true,
        rerankTopK: 3,
      },
      activeParsedQuery: {
        semanticQuery: "yoga",
      },
      activeQuery: "yoga",
      scoredCandidates,
    } as never);

    expect(rerankCandidateCount).toBe(RETRIEVAL_BEHAVIOR.finalContextTopK);
    expect(result.rerankedContexts).toHaveLength(RETRIEVAL_BEHAVIOR.finalContextTopK);
    expect(result.contexts).toHaveLength(RETRIEVAL_BEHAVIOR.finalContextTopK);
  });

  it("packs excerpts from large chunks and skips low-information fragments", () => {
    const selector = new PromptContextSelectorService(1_600);
    const largeContent = `${"Large yoga product and course context. ".repeat(120)}Final detail that should be trimmed.`;

    const result = selector.select({
      topK: 5,
      contexts: [
        rerankedCandidate({
          chunkId: "large-shop",
          documentId: "shop",
          title: "Yoga e Meditazione",
          content: largeContent,
          score: 0.99,
          rerankPosition: 0,
        }),
        rerankedCandidate({
          chunkId: "course-basic-1",
          documentId: "course-basic-1",
          title: "Ananda Yoga Basic 1",
          content: "Course details for Ananda Yoga Basic 1, including practice, meditation, and residential context.",
          score: 0.96,
          rerankPosition: 1,
        }),
        rerankedCandidate({
          chunkId: "boilerplate",
          documentId: "empty-event",
          title: "Yoga to Relieve Stress",
          content: "Back to All Events",
          score: 0.95,
          rerankPosition: 2,
        }),
        rerankedCandidate({
          chunkId: "course-basic-2",
          documentId: "course-basic-2",
          title: "Ananda Yoga Basic 2",
          content: "Course details for Ananda Yoga Basic 2, including next-level practice and guided meditation.",
          score: 0.94,
          rerankPosition: 3,
        }),
        rerankedCandidate({
          chunkId: "guided-yoga",
          documentId: "guided-yoga",
          title: "Guided Ananda Yoga",
          content: "Guided Ananda Yoga recordings include posture practice, pranayama, and meditation warm-ups.",
          score: 0.93,
          rerankPosition: 4,
        }),
        rerankedCandidate({
          chunkId: "chakra-yoga",
          documentId: "chakra-yoga",
          title: "Ananda Yoga to Awaken the Chakras",
          content: "Ananda Yoga to Awaken the Chakras connects posture practice with energy awareness.",
          score: 0.92,
          rerankPosition: 5,
        }),
      ],
    });

    expect(result.map((context) => context.chunkId)).toEqual([
      "large-shop",
      "course-basic-1",
      "course-basic-2",
      "guided-yoga",
      "chakra-yoga",
    ]);
    expect(result[0]?.content.length).toBeLessThan(largeContent.length);
    expect(result[0]?.content).not.toContain("Final detail that should be trimmed.");
  });

  it("fills remaining context slots with low-information fragments only when useful context is exhausted", () => {
    const selector = new PromptContextSelectorService(1_200);

    const result = selector.select({
      topK: 3,
      contexts: [
        rerankedCandidate({
          chunkId: "main-doc",
          documentId: "doc-1",
          title: "Primary Course",
          content: "Primary course overview with answerable details.",
          score: 0.99,
          rerankPosition: 0,
        }),
        rerankedCandidate({
          chunkId: "low-1",
          documentId: "chrome-1",
          title: "Site Navigation",
          content: "Back to All Events",
          score: 0.98,
          rerankPosition: 1,
        }),
        rerankedCandidate({
          chunkId: "low-2",
          documentId: "chrome-2",
          title: "Accessibility",
          content: "Skip to content",
          score: 0.97,
          rerankPosition: 2,
        }),
      ],
    });

    expect(result.map((context) => context.chunkId)).toEqual(["main-doc", "low-1", "low-2"]);
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
    expect(result.prompt).toContain("Website Excerpts:");
    expect(result.prompt).toContain("do not pad the answer just to use more results");
    expect(result.prompt).toContain("Do not end with generic offers");
    expect(result.prompt).toContain("Never mention internal evidence mechanics");
    expect(result.prompt).toContain("Put the link on the descriptive noun phrase inside the answer sentence");
    expect(result.prompt).toContain("not as a trailing");
    expect(result.prompt).toContain("include exactly one inline Markdown link in the answer by default");
    expect(result.prompt).toContain("Do this even for definitional answers");
    expect(result.prompt).toContain("append <<UNSUPPORTED>> at the very end");
    expect(result.prompt).toContain("Result 1 (Intro):");
    expect(result.prompt).toContain("[[n]]");
    expect(result.citations).toEqual([{ documentId: "d1", chunkId: "c1", title: "Intro" }]);
  });

  it("uses a wider default final context target for broad source coverage", () => {
    const selector = new PromptContextSelectorService();
    const result = selector.select({
      topK: RETRIEVAL_BEHAVIOR.finalContextTopK,
      contexts: Array.from({ length: RETRIEVAL_BEHAVIOR.finalContextTopK }, (_, index) =>
        rerankedCandidate({
          chunkId: `yoga-${index + 1}`,
          documentId: `yoga-doc-${index + 1}`,
          title: `Yoga Source ${index + 1}`,
          content: `Useful yoga source ${index + 1} with course, practice, or category details.`,
          score: 1 - index / 100,
          rerankPosition: index,
        }),
      ),
    });

    expect(RETRIEVAL_BEHAVIOR.finalContextTopK).toBeGreaterThanOrEqual(10);
    expect(result).toHaveLength(RETRIEVAL_BEHAVIOR.finalContextTopK);
  });

  it("returns a retrieval-scoped unsupported result for non-retrieval intent", async () => {
    const service = new RetrievalAnswerService({
      retrievalPipeline: {
        async interpret() {
          return {
            interpretation: {
              result: {
                responseIntent: "assistant_identity",
              },
            },
          };
        },
        async runInterpreted() {
          throw new Error("runInterpreted must not be called for unsupported retrieval intents");
        },
      },
      chatGateway: {
        async answer() {
          throw new Error("answer generation must not run for unsupported retrieval intents");
        },
      },
    } as never);

    await expect(service.answer({
      workspaceId: "workspace-1",
      query: "who are you?",
    })).resolves.toEqual({
      outcome: "unsupported",
      code: "unsupported_query_type",
      reason: "assistant_identity",
      message: "This request is outside retrieval scope.",
    });
  });
});
