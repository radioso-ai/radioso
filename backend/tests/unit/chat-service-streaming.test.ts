import { describe, expect, it } from "vitest";

import {
  BlankChatAnswerError,
  ChatService,
  type ChatGateway,
  type ChatStreamEvent,
} from "../../src/modules/chat/services/chatService.js";
import type { GroundedMissResponseComposer } from "../../src/modules/chat/services/groundedMissResponseComposer.js";
import {
  createAuditService,
  InMemoryAuditEventRepository,
  InMemoryConversationRepository,
  InMemoryMessageRepository,
} from "../support/fakes.js";

const groundedMissResponseComposer: GroundedMissResponseComposer = {
  async composeUnsupportedWithContext(input) {
    const title = input.contexts[0]?.title;
    return title
      ? `I couldn't verify that from your workspace documents, but I did find related material in "${title}" if you'd like to explore that instead.`
      : "I couldn't verify that from your workspace documents, but I did find related material if you'd like to explore that instead.";
  },
  async composeNoContext() {
    return "I couldn't find supporting material for that in your workspace documents. If you'd like, try asking about a topic that's covered there.";
  },
};

const asChatRetrievalPipeline = (pipeline: Record<string, unknown>) => {
  if (
    typeof pipeline.interpret === "function"
    && typeof pipeline.runInterpreted === "function"
    && typeof pipeline.runWithoutRetrieval === "function"
  ) {
    return pipeline;
  }

  if (typeof pipeline.run !== "function") {
    return pipeline;
  }

  return {
    ...pipeline,
    async interpret(input: {
      workspaceId: string;
      query: string;
      history: unknown[];
      responseIdentity?: unknown;
      responseBehaviorEnabled?: boolean;
      metadataFilter?: Record<string, unknown>;
    }) {
      return {
        request: input,
        traceStartedAtMs: Date.now(),
        context: {
          startedAt: Date.now(),
          durationMs: 1,
          result: {
            request: input,
            settings: {
              workspaceId: input.workspaceId,
              queryRewriteEnabled: true,
              semanticRewriteInstructions: "",
              lexicalRewriteInstructions: "",
              conversationMode: "guided",
              suggestedQuestionsEnabled: true,
              suggestedQuestionsCount: 3,
              rerankEnabled: false,
              vectorTopK: 20,
              similarityThreshold: 0.1,
              rerankTopK: 5,
              citationDisplayEnabled: true,
              customInstruction: "",
              metadataRules: [],
              createdAt: new Date(),
              updatedAt: new Date(),
            },
            contextWindow: {
              selectedMessages: [],
              truncated: false,
              selectionReason: "full-history",
            },
          },
        },
        interpretation: {
          startedAt: Date.now(),
          durationMs: 1,
          result: {
            responseIntent: "retrieval",
          },
        },
      };
    },
    async runInterpreted(interpretation: { request: unknown }) {
      return (pipeline.run as (input: unknown) => unknown | Promise<unknown>)(interpretation.request);
    },
    async runWithoutRetrieval() {
      throw new Error("runWithoutRetrieval should not be used for retrieval turns");
    },
  };
};

describe("chat service streaming", () => {
  const createIntentRoutedNoContextPipeline = (input: {
    query: string;
    responseIntent: "social_only" | "assistant_identity";
    responseIdentity?: {
      name: string;
    };
    customInstruction?: string;
  }) => ({
    async run() {
      throw new Error("run should not be used when intent routing is available");
    },
    async interpret() {
      return {
        request: {
          workspaceId: "workspace-1",
          query: input.query,
          history: [],
          responseIdentity: input.responseIdentity ?? null,
        },
        traceStartedAtMs: Date.now(),
        context: {
          startedAt: Date.now(),
          durationMs: 1,
          result: {
            request: {
              workspaceId: "workspace-1",
              query: input.query,
              history: [],
              responseIdentity: input.responseIdentity ?? null,
            },
            settings: {
              workspaceId: "workspace-1",
              queryRewriteEnabled: true,
              semanticRewriteInstructions: "",
              lexicalRewriteInstructions: "",
              conversationMode: "guided",
              suggestedQuestionsEnabled: true,
              suggestedQuestionsCount: 3,
              rerankEnabled: false,
              vectorTopK: 20,
              similarityThreshold: 0.1,
              rerankTopK: 5,
              citationDisplayEnabled: true,
              customInstruction: input.customInstruction ?? "",
              metadataRules: [],
              createdAt: new Date(),
              updatedAt: new Date(),
            },
            contextWindow: {
              selectedMessages: [],
              truncated: false,
              selectionReason: "full-history",
            },
          },
        },
        interpretation: {
          startedAt: Date.now(),
          durationMs: 1,
          result: {
            responseIntent: input.responseIntent,
          },
        },
      };
    },
    async runInterpreted() {
      throw new Error("runInterpreted should not be used for non-retrieval turns");
    },
    async runWithoutRetrieval() {
      return {
        rewrittenQuery: input.query,
        contexts: [],
        prompt: "",
        citations: [],
        responseIdentity: input.responseIdentity ?? null,
        responseSettings: {
          citationDisplayEnabled: true,
          conversationMode: "guided",
          suggestedQuestionsEnabled: true,
          suggestedQuestionsCount: 3,
          customInstruction: input.customInstruction ?? "",
          responseLanguagePolicy: "match_user_question",
        },
        diagnostics: {
          rewriteStatus: "applied",
          rerankStatus: "skipped",
          originalCandidateCount: 0,
          rewrittenCandidateCount: 0,
          lexicalCandidateCount: 0,
          normalizedCandidateCount: 0,
          finalContextCount: 0,
          candidateFallbackApplied: false,
          fallbackApplied: false,
          responseIntent: input.responseIntent,
          retrievalSkipped: true,
          intentConfidence: 0.9,
          intentFallbackApplied: false,
          parsedQuery: {
            originalQuery: input.query,
            semanticQuery: input.query,
            lexicalQuery: input.query,
            constraints: [],
          },
          triggerAnalysis: {
            status: "skipped_non_retrieval",
            consideredRules: [],
            matchedRuleIds: [],
            unmatchedRuleIds: [],
            matchCount: 0,
            matcherVersion: "non_retrieval",
          },
        },
        trace: {
          traceId: `trace-${input.responseIntent}`,
          startedAt: new Date().toISOString(),
          stages: [
            { stageId: "diagnostics", kind: "diagnostics", label: "Diagnostics", status: "skipped" },
          ],
          links: [],
        },
      };
    },
  });

  it("persists the normalized assistant answer only after the stream completes", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run() {
        return {
          rewrittenQuery: "what does this page do",
          contexts: [
            {
              chunkId: "chunk-1",
              documentId: "doc-1",
              title: "Intro",
              content: "full answer",
            },
          ],
          prompt: "prompt text",
          citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Intro" }],
          diagnostics: {
            rewriteStatus: "skipped",
            rerankStatus: "skipped",
            originalCandidateCount: 1,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 1,
            normalizedCandidateCount: 1,
            finalContextCount: 1,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            parsedQuery: {
              semanticQuery: "page do",
              lexicalQuery: "page do",
              constraints: [],
            },
          },
          responseSettings: {
            citationDisplayEnabled: true,
            conversationMode: "guided",
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer() {
        return "full answer[[1]]";
      },
      async *streamAnswer() {
        yield "full answer[[";
        yield "1]]";
      },
    };
    const service = new ChatService(
      conversationRepository,
      messageRepository,
      asChatRetrievalPipeline(retrievalPipeline) as never,
      chatGateway,
      auditService,
      groundedMissResponseComposer,
    );

    const events: ChatStreamEvent[] = [];

    for await (const event of service.streamAnswer({
      workspaceId: "workspace-1",
      query: "What does this page do?",
      stream: true,
    })) {
      events.push(event);

      if (event.type === "chunk") {
        expect(event.text).not.toContain("[[");
        const [conversationId] = conversationRepository.items.keys();
        const persisted = await messageRepository.listByConversationId("workspace-1", conversationId!);
        expect(persisted.map((message) => message.role)).toEqual(["user"]);
      }
    }

    expect(events[0]).toEqual({ type: "conversation", conversationId: expect.any(String) });
    expect(events[1]).toEqual({ type: "chunk", text: "full answer" });
    expect(events[2]).toEqual({
      type: "done",
      conversationId: expect.any(String),
      assistantMessageId: expect.any(String),
      route: {
        type: "retrieval",
        reason: "evidence_required",
      },
      answer: "full answer",
      citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Intro" }],
      answerSegments: [{ text: "full answer", citationIndices: [0] }],
      suggestions: undefined,
      conversationMode: "guided",
      conversationModeMetadata: {
        conversationMode: "guided",
        brevityOverrideApplied: false,
        expansionApplied: false,
        expansionKind: "none",
        suggestionCount: 0,
        followUpQuestionApplied: false,
      },
      retrievalInfo: expect.objectContaining({
        parsedQuery: expect.objectContaining({
          originalQuery: "page do",
          semanticQuery: "page do",
          lexicalQuery: "page do",
          constraintSummary: [],
        }),
        candidateCounts: {
          semantic: 1,
          lexical: 1,
          merged: 1,
          final: 1,
        },
        fallbackApplied: false,
        rerankStatus: "skipped",
        rewrite: expect.objectContaining({
          status: "skipped",
          eligible: false,
          ran: false,
        }),
      }),
      retrievalTrace: expect.objectContaining({
        stages: expect.arrayContaining([
          expect.objectContaining({
            stageId: "answer",
            kind: "answer_outcome",
            status: "applied",
          }),
        ]),
      }),
    });

    const [conversationId] = conversationRepository.items.keys();
    const persisted = await messageRepository.listByConversationId("workspace-1", conversationId!);
    expect(persisted.map((message) => ({ role: message.role, content: message.content }))).toEqual([
      { role: "user", content: "What does this page do?" },
      { role: "assistant", content: "full answer" },
    ]);
    expect(auditService.events[0]?.metadata?.workflow).toBe("chat.turn");
    expect(auditService.events[0]?.metadata?.executionClass).toBe("interactive_synchronous");
    expect(auditService.events[0]?.metadata?.rewriteContinuityState).toEqual({
      activeSubject: "Intro",
      relatedEntities: [],
      groundedTitles: ["Intro"],
    });
  });

  it("fails blank grounded streams instead of persisting an empty assistant turn", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run() {
        return {
          rewrittenQuery: "what does this page do",
          contexts: [
            {
              chunkId: "chunk-1",
              documentId: "doc-1",
              title: "Intro",
              content: "full answer",
            },
          ],
          prompt: "prompt text",
          citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Intro" }],
          diagnostics: {
            rewriteStatus: "skipped",
            rerankStatus: "skipped",
            originalCandidateCount: 1,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 1,
            normalizedCandidateCount: 1,
            finalContextCount: 1,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            parsedQuery: {
              semanticQuery: "page do",
              lexicalQuery: "page do",
              constraints: [],
            },
          },
          responseSettings: {
            citationDisplayEnabled: true,
            conversationMode: "guided",
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer() {
        return "unused";
      },
      async *streamAnswer() {
        yield "";
        yield "   ";
        yield "";
      },
    };
    const service = new ChatService(
      conversationRepository,
      messageRepository,
      asChatRetrievalPipeline(retrievalPipeline) as never,
      chatGateway,
      auditService,
      groundedMissResponseComposer,
    );

    const iterator = service.streamAnswer({
      workspaceId: "workspace-1",
      query: "What does this page do?",
      stream: true,
    })[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: {
        type: "conversation",
        conversationId: expect.any(String),
      },
    });
    await expect(iterator.next()).rejects.toBeInstanceOf(BlankChatAnswerError);

    const [conversationId] = conversationRepository.items.keys();
    const persisted = await messageRepository.listByConversationId("workspace-1", conversationId!);
    expect(persisted.map((message) => ({ role: message.role, content: message.content }))).toEqual([
      { role: "user", content: "What does this page do?" },
    ]);
    expect(auditService.events).toContainEqual(
      expect.objectContaining({
        eventType: "chat.answer",
        eventStatus: "failure",
        metadata: expect.objectContaining({
          errorMessage: "chat_answer_generation_failed",
          stream: true,
        }),
      }),
    );
  });

  it("answers assistant identity questions without retrieved document context", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = createIntentRoutedNoContextPipeline({
      query: "What is your name and what do you do?",
      responseIntent: "assistant_identity",
      responseIdentity: {
        name: "Marta",
      },
    });
    const chatGateway: ChatGateway = {
      async answer() {
        return "My name is Marta. I am your museum guide.";
      },
      async *streamAnswer() {
        yield "unused";
      },
    };
    const service = new ChatService(
      conversationRepository,
      messageRepository,
      asChatRetrievalPipeline(retrievalPipeline) as never,
      chatGateway,
      auditService,
      groundedMissResponseComposer,
    );

    const response = await service.answer({
      workspaceId: "workspace-1",
      query: "What is your name and what do you do?",
      stream: false,
    });

    expect(response.answer).toContain("Marta");
    expect(response.answer).toContain("museum guide");
    expect(response.citations).toBeUndefined();
    expect(response.answerSegments).toBeUndefined();
  });

  it("falls back to the normal no-context response when the identity prompt returns blank output", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = createIntentRoutedNoContextPipeline({
      query: "What is your name?",
      responseIntent: "assistant_identity",
      responseIdentity: {
        name: "Marta",
      },
    });
    const chatGateway: ChatGateway = {
      async answer() {
        throw new BlankChatAnswerError();
      },
      async *streamAnswer() {
        yield "unused";
      },
    };
    const service = new ChatService(
      conversationRepository,
      messageRepository,
      asChatRetrievalPipeline(retrievalPipeline) as never,
      chatGateway,
      auditService,
      groundedMissResponseComposer,
    );

    const response = await service.answer({
      workspaceId: "workspace-1",
      query: "What is your name?",
      stream: false,
    });

    expect(response.answer).toEqual(expect.any(String));
    expect(response.answer.length).toBeGreaterThan(0);
  });

  it("does not swallow provider failures from the identity prompt", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = createIntentRoutedNoContextPipeline({
      query: "What is your name?",
      responseIntent: "assistant_identity",
      responseIdentity: {
        name: "Marta",
      },
    });
    const chatGateway: ChatGateway = {
      async answer() {
        throw new Error("provider unavailable");
      },
      async *streamAnswer() {
        yield "unused";
      },
    };
    const service = new ChatService(
      conversationRepository,
      messageRepository,
      asChatRetrievalPipeline(retrievalPipeline) as never,
      chatGateway,
      auditService,
      groundedMissResponseComposer,
    );

    await expect(
      service.answer({
        workspaceId: "workspace-1",
        query: "What is your name?",
        stream: false,
      }),
    ).rejects.toThrow("provider unavailable");

    expect(auditService.events).toContainEqual(
      expect.objectContaining({
        eventType: "chat.answer",
        eventStatus: "failure",
        metadata: expect.objectContaining({
          errorMessage: "provider unavailable",
        }),
      }),
    );
  });

  it("streams assistant identity answers for no-context follow-ups", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = createIntentRoutedNoContextPipeline({
      query: "What do you do?",
      responseIntent: "assistant_identity",
      responseIdentity: {
        name: "Marta",
      },
    });
    const chatGateway: ChatGateway = {
      async answer() {
        return "I am Marta, and I help visitors navigate the museum.";
      },
      async *streamAnswer() {
        yield "unused";
      },
    };
    const service = new ChatService(
      conversationRepository,
      messageRepository,
      asChatRetrievalPipeline(retrievalPipeline) as never,
      chatGateway,
      auditService,
      groundedMissResponseComposer,
    );

    const events: ChatStreamEvent[] = [];
    for await (const event of service.streamAnswer({
      workspaceId: "workspace-1",
      query: "What do you do?",
      stream: true,
    })) {
      events.push(event);
    }

    expect(events[0]).toEqual({ type: "conversation", conversationId: expect.any(String) });
    expect(events[1]).toEqual({ type: "chunk", text: expect.any(String) });
    expect(events[2]).toEqual(
      expect.objectContaining({
        type: "done",
        answer: expect.any(String),
      }),
    );
  });

  it("falls back to the normal no-context response when a streamed non-retrieval answer is blank", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = createIntentRoutedNoContextPipeline({
      query: "What do you do?",
      responseIntent: "assistant_identity",
      responseIdentity: {
        name: "Marta",
      },
    });
    const chatGateway: ChatGateway = {
      async answer() {
        throw new BlankChatAnswerError();
      },
      async *streamAnswer() {
        yield "unused";
      },
    };
    const service = new ChatService(
      conversationRepository,
      messageRepository,
      asChatRetrievalPipeline(retrievalPipeline) as never,
      chatGateway,
      auditService,
      groundedMissResponseComposer,
    );

    const events: ChatStreamEvent[] = [];
    for await (const event of service.streamAnswer({
      workspaceId: "workspace-1",
      query: "What do you do?",
      stream: true,
    })) {
      events.push(event);
    }

    expect(events[1]).toEqual({
      type: "chunk",
      text: "I couldn't find supporting material for that in your workspace documents. If you'd like, try asking about a topic that's covered there.",
    });
    expect(events[2]).toEqual(
      expect.objectContaining({
        type: "done",
        answer: "I couldn't find supporting material for that in your workspace documents. If you'd like, try asking about a topic that's covered there.",
      }),
    );
  });

  it("does not treat broader task questions as assistant identity questions", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run() {
        return {
          rewrittenQuery: "what can you do with these documents",
          contexts: [],
          prompt: "unused retrieval prompt",
          citations: [],
          responseIdentity: {
            name: "Marta",
          },
          diagnostics: {
            rewriteStatus: "skipped",
            rerankStatus: "skipped",
            originalCandidateCount: 0,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 0,
            normalizedCandidateCount: 0,
            finalContextCount: 0,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            parsedQuery: {
              semanticQuery: "what can you do with these documents",
              lexicalQuery: "what can you do with these documents",
              constraints: [],
            },
          },
          responseSettings: {
            citationDisplayEnabled: true,
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer() {
        throw new Error("identity prompt should not run");
      },
      async *streamAnswer() {
        yield "unused";
      },
    };
    const service = new ChatService(
      conversationRepository,
      messageRepository,
      asChatRetrievalPipeline(retrievalPipeline) as never,
      chatGateway,
      auditService,
      groundedMissResponseComposer,
    );

    const response = await service.answer({
      workspaceId: "workspace-1",
      query: "What can you do with these documents?",
      stream: false,
    });

    expect(response.answer).toEqual(expect.any(String));
    expect(response.answer.length).toBeGreaterThan(0);
    expect(response.citations).toBeUndefined();
  });

  it("passes assistant instructions into retrieval no-context fallback", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    let observedNoContextInstruction = "";
    const retrievalPipeline = {
      async run() {
        return {
          rewrittenQuery: "I like potato chips",
          contexts: [],
          prompt: "unused retrieval prompt",
          citations: [],
          responseIdentity: {
            name: "Vikram",
          },
          diagnostics: {
            rewriteStatus: "skipped",
            rerankStatus: "fallback",
            originalCandidateCount: 0,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 0,
            normalizedCandidateCount: 0,
            finalContextCount: 0,
            candidateFallbackApplied: false,
            fallbackApplied: true,
            responseIntent: "retrieval",
            retrievalSkipped: false,
            parsedQuery: {
              semanticQuery: "I like potato chips",
              lexicalQuery: "I like potato chips",
              constraints: [],
            },
          },
          responseSettings: {
            citationDisplayEnabled: true,
            conversationMode: "exploratory",
            customInstruction: "Help visitors choose and book Ananda courses.",
            responseLanguagePolicy: "match_user_question",
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer() {
        throw new Error("retrieval answer should not run without contexts");
      },
      async *streamAnswer() {
        yield "unused";
      },
    };
    const fallbackComposer: GroundedMissResponseComposer = {
      async composeUnsupportedWithContext() {
        return "unused";
      },
      async composeNoContext(input) {
        observedNoContextInstruction = input.answerInstructionBlock ?? "";
        return "I can't tell from that. I can help you choose and book Ananda courses.";
      },
    };
    const service = new ChatService(
      conversationRepository,
      messageRepository,
      asChatRetrievalPipeline(retrievalPipeline) as never,
      chatGateway,
      auditService,
      fallbackComposer,
    );

    const response = await service.answer({
      workspaceId: "workspace-1",
      query: "I like potato chips",
      stream: false,
    });

    expect(response.answer).toBe("I can't tell from that. I can help you choose and book Ananda courses.");
    expect(observedNoContextInstruction).toContain("Stable assistant identity:");
    expect(observedNoContextInstruction).toContain("Vikram");
    expect(observedNoContextInstruction).toContain("Workspace-specific instructions:");
    expect(observedNoContextInstruction).toContain("Help visitors choose and book Ananda courses.");
    expect(observedNoContextInstruction).toContain("Conversation mode: exploratory.");
  });

  it("excludes URL-shaped citation titles from carry-forward literals", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run(input: { query: string }) {
        return {
          rewrittenQuery: input.query,
          contexts: [
            {
              chunkId: "chunk-1",
              documentId: "doc-1",
              title: "https://riigiteataja.ee/akt/118122025017.xml",
              content: "full answer",
            },
          ],
          prompt: "prompt text",
          citations: [
            {
              documentId: "doc-1",
              chunkId: "chunk-1",
              title: "https://riigiteataja.ee/akt/118122025017.xml",
            },
          ],
          diagnostics: {
            rewriteStatus: "applied",
            rerankStatus: "skipped",
            originalCandidateCount: 1,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 0,
            normalizedCandidateCount: 1,
            finalContextCount: 1,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            rewriteProposal: {
              rewrittenQuery: "Eestis hetkel kehtiv kaibemaksumaar (KM)",
              turnKind: "fresh_subject",
              proposedActiveSubject: "kaibemaksumaar Eestis",
              relatedEntities: [],
              unresolved: false,
              confidence: 0.8,
            },
            parsedQuery: {
              semanticQuery: "kaibemaks",
              lexicalQuery: "kaibemaks",
              constraints: [],
            },
          },
          responseSettings: {
            citationDisplayEnabled: true,
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer() {
        return "full answer[[1]]";
      },
      async *streamAnswer() {
        yield "full answer[[1]]";
      },
    };
    const service = new ChatService(
      conversationRepository,
      messageRepository,
      asChatRetrievalPipeline(retrievalPipeline) as never,
      chatGateway,
      auditService,
      groundedMissResponseComposer,
    );

    const first = await service.answer({
      workspaceId: "workspace-1",
      accountId: "account-1",
      query: "Mis juhtub, kui ma ei maksa tulumaksu?",
      stream: false,
    });

    await service.answer({
      workspaceId: "workspace-1",
      accountId: "account-1",
      conversationId: first.conversationId,
      query: "mis on hetkel kehtiv kaibemaks?",
      stream: false,
    });

    expect(auditService.events[0]?.metadata?.rewriteContinuityState).toEqual({
      activeSubject: "kaibemaksumaar Eestis",
      relatedEntities: [],
      groundedTitles: [],
    });
  });

  it("drops inferred related entities from rewrite continuity state", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run() {
        return {
          rewrittenQuery: "Does Narayani work with Arudra?",
          contexts: [
            {
              chunkId: "chunk-1",
              documentId: "doc-1",
              title: "Narayani",
              content: "full answer",
            },
          ],
          prompt: "prompt text",
          citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Narayani" }],
          diagnostics: {
            rewriteStatus: "applied",
            rerankStatus: "skipped",
            originalCandidateCount: 1,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 1,
            normalizedCandidateCount: 1,
            finalContextCount: 1,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            rewriteProposal: {
              rewrittenQuery: "Does Narayani work with Arudra?",
              turnKind: "referential_relation",
              proposedActiveSubject: "Narayani",
              relatedEntities: ["Arudra"],
              unresolved: true,
              confidence: 0.62,
            },
            parsedQuery: {
              semanticQuery: "does narayani work with arudra",
              lexicalQuery: "does narayani work with arudra",
              constraints: [],
            },
          },
          responseSettings: {
            citationDisplayEnabled: true,
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer() {
        return "full answer[[1]]";
      },
      async *streamAnswer() {
        yield "full answer[[1]]";
      },
    };
    const service = new ChatService(
      conversationRepository,
      messageRepository,
      asChatRetrievalPipeline(retrievalPipeline) as never,
      chatGateway,
      auditService,
      groundedMissResponseComposer,
    );

    await service.answer({
      workspaceId: "workspace-1",
      accountId: "account-1",
      query: "Does she work with Arudra?",
      stream: false,
    });

    expect(auditService.events[0]?.metadata?.rewriteContinuityState).toEqual({
      activeSubject: "Narayani",
      relatedEntities: [],
      groundedTitles: ["Narayani"],
    });
  });

  it("includes the normalized final answer in the done event when a malformed anchor is truncated during streaming", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run() {
        return {
          rewrittenQuery: "what does this page do",
          contexts: [
            {
              chunkId: "chunk-1",
              documentId: "doc-1",
              title: "Intro",
              content: "full answer",
            },
          ],
          prompt: "prompt text",
          citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Intro" }],
          diagnostics: {
            rewriteStatus: "skipped",
            rerankStatus: "skipped",
            originalCandidateCount: 1,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 1,
            normalizedCandidateCount: 1,
            finalContextCount: 1,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            parsedQuery: {
              semanticQuery: "page do",
              lexicalQuery: "page do",
              constraints: [],
            },
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer() {
        return "full answer [[ marker";
      },
      async *streamAnswer() {
        yield "full answer [[";
        yield " marker";
      },
    };
    const service = new ChatService(
      conversationRepository,
      messageRepository,
      asChatRetrievalPipeline(retrievalPipeline) as never,
      chatGateway,
      auditService,
      groundedMissResponseComposer,
    );

    const chunkTexts: string[] = [];
    let doneEvent: Extract<ChatStreamEvent, { type: "done" }> | undefined;

    for await (const event of service.streamAnswer({
      workspaceId: "workspace-1",
      query: "What does this page do?",
      stream: true,
    })) {
      if (event.type === "chunk") {
        chunkTexts.push(event.text);
      }

      if (event.type === "done") {
        doneEvent = event;
      }
    }

    expect(chunkTexts.join("")).toBe("full answer ");
    expect(doneEvent).toEqual(expect.objectContaining({
      type: "done",
      conversationId: expect.any(String),
      answer: "full answer  marker",
      citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Intro" }],
      answerSegments: [{ text: "full answer  marker", citationIndices: [0] }],
      conversationMode: "guided",
      conversationModeMetadata: {
        conversationMode: "guided",
        brevityOverrideApplied: false,
        expansionApplied: false,
        expansionKind: "none",
        suggestionCount: 0,
        followUpQuestionApplied: false,
      },
      retrievalInfo: expect.objectContaining({
        candidateCounts: {
          semantic: 1,
          lexical: 1,
          merged: 1,
          final: 1,
        },
      }),
      retrievalTrace: expect.objectContaining({
        stages: expect.arrayContaining([
          expect.objectContaining({
            stageId: "answer",
            kind: "answer_outcome",
            status: "applied",
          }),
        ]),
      }),
    }));

    const [conversationId] = conversationRepository.items.keys();
    const persisted = await messageRepository.listByConversationId("workspace-1", conversationId!);
    expect(persisted.at(-1)).toMatchObject({
      role: "assistant",
      content: "full answer  marker",
    });
  });

  it("drops trailing incomplete citation anchor carry when the stream ends", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run() {
        return {
          rewrittenQuery: "what does this page do",
          contexts: [
            {
              chunkId: "chunk-1",
              documentId: "doc-1",
              title: "Intro",
              content: "full answer",
            },
          ],
          prompt: "prompt text",
          citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Intro" }],
          diagnostics: {
            rewriteStatus: "skipped",
            rerankStatus: "skipped",
            originalCandidateCount: 1,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 1,
            normalizedCandidateCount: 1,
            finalContextCount: 1,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            parsedQuery: {
              semanticQuery: "page do",
              lexicalQuery: "page do",
              constraints: [],
            },
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer() {
        return "full answer[[";
      },
      async *streamAnswer() {
        yield "full answer[[";
      },
    };
    const service = new ChatService(
      conversationRepository,
      messageRepository,
      asChatRetrievalPipeline(retrievalPipeline) as never,
      chatGateway,
      auditService,
      groundedMissResponseComposer,
    );

    const chunkTexts: string[] = [];
    let doneEvent: Extract<ChatStreamEvent, { type: "done" }> | undefined;

    for await (const event of service.streamAnswer({
      workspaceId: "workspace-1",
      query: "What does this page do?",
      stream: true,
    })) {
      if (event.type === "chunk") {
        chunkTexts.push(event.text);
      }

      if (event.type === "done") {
        doneEvent = event;
      }
    }

    expect(chunkTexts).toEqual(["full answer"]);
    expect(doneEvent).toEqual({
      type: "done",
      conversationId: expect.any(String),
      assistantMessageId: expect.any(String),
      route: {
        type: "retrieval",
        reason: "evidence_required",
      },
      answer: `I couldn't verify that from your workspace documents, but I did find related material in "Intro" if you'd like to explore that instead.`,
      citations: [],
      answerSegments: [
        { text: `I couldn't verify that from your workspace documents, but I did find related material in "Intro" if you'd like to explore that instead.` },
      ],
      suggestions: undefined,
      conversationMode: "guided",
      conversationModeMetadata: {
        conversationMode: "guided",
        brevityOverrideApplied: false,
        expansionApplied: false,
        expansionKind: "none",
        suggestionCount: 0,
        followUpQuestionApplied: false,
      },
      retrievalInfo: expect.objectContaining({
        candidateCounts: {
          semantic: 1,
          lexical: 1,
          merged: 1,
          final: 1,
        },
      }),
      retrievalTrace: expect.objectContaining({
        stages: expect.arrayContaining([
          expect.objectContaining({
            stageId: "answer",
            kind: "answer_outcome",
            status: "applied",
          }),
        ]),
      }),
    });

    const [conversationId] = conversationRepository.items.keys();
    const persisted = await messageRepository.listByConversationId("workspace-1", conversationId!);
    expect(persisted.at(-1)).toMatchObject({
      role: "assistant",
      content: `I couldn't verify that from your workspace documents, but I did find related material in "Intro" if you'd like to explore that instead.`,
    });
  });

  it("does not persist a duplicate assistant turn when touch fails after the assistant answer is written", async () => {
    class FailingTouchConversationRepository extends InMemoryConversationRepository {
      override async touch(_conversationId: string, _workspaceId: string): Promise<void> {
        throw new Error("touch failed");
      }
    }

    const conversationRepository = new FailingTouchConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run() {
        return {
          contexts: [],
          prompt: "prompt text",
          diagnostics: {
            rewriteStatus: "skipped",
            rerankStatus: "skipped",
            originalCandidateCount: 0,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 0,
            normalizedCandidateCount: 0,
            finalContextCount: 0,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            parsedQuery: {
              semanticQuery: "",
              lexicalQuery: "",
              constraints: [],
            },
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer() {
        return "full answer";
      },
      async *streamAnswer() {
        yield "full answer";
      },
    };
    const service = new ChatService(
      conversationRepository,
      messageRepository,
      asChatRetrievalPipeline(retrievalPipeline) as never,
      chatGateway,
      auditService,
      groundedMissResponseComposer,
    );

    await expect(service.answer({
      workspaceId: "workspace-1",
      query: "What does this page do?",
      stream: false,
    })).rejects.toThrow("touch failed");

    const [conversationId] = conversationRepository.items.keys();
    const persisted = await messageRepository.listByConversationId("workspace-1", conversationId!);
    expect(persisted.map((message) => ({ role: message.role, content: message.content }))).toEqual([
      { role: "user", content: "What does this page do?" },
      {
        role: "assistant",
        content: expect.any(String),
      },
    ]);
  });

  it("does not create an empty conversation when retrieval fails before the first turn is persisted", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run() {
        throw new Error("retrieval failed");
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer() {
        return "unused";
      },
      async *streamAnswer() {
        yield "unused";
      },
    };
    const service = new ChatService(
      conversationRepository,
      messageRepository,
      asChatRetrievalPipeline(retrievalPipeline) as never,
      chatGateway,
      auditService,
    );

    await expect(service.answer({
      workspaceId: "workspace-1",
      query: "What does this page do?",
      stream: false,
    })).rejects.toThrow("retrieval failed");

    expect(conversationRepository.items.size).toBe(0);
  });

  it("replaces unsupported substantive content before returning a non-streaming grounded answer", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run() {
        return {
          rewrittenQuery: "what does this page do",
          contexts: [
            {
              chunkId: "chunk-1",
              documentId: "doc-1",
              title: "Guide",
              content: "The page explains testing and parsing content for users.",
            },
          ],
          prompt: "prompt text",
          citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Guide" }],
          diagnostics: {
            rewriteStatus: "skipped",
            rerankStatus: "skipped",
            originalCandidateCount: 1,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 1,
            normalizedCandidateCount: 1,
            finalContextCount: 1,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            parsedQuery: {
              semanticQuery: "page do",
              lexicalQuery: "page do",
              constraints: [],
            },
          },
          responseSettings: {
            citationDisplayEnabled: true,
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer() {
        return "The page explains testing and parsing content for users[[1]]. It also offers 24/7 phone support.";
      },
      async *streamAnswer() {
        yield "unused";
      },
    };
    const service = new ChatService(
      conversationRepository,
      messageRepository,
      asChatRetrievalPipeline(retrievalPipeline) as never,
      chatGateway,
      auditService,
    );

    const response = await service.answer({
      workspaceId: "workspace-1",
      accountId: "account-1",
      query: "What does this page do?",
      stream: false,
    });

    expect(response.answer).toEqual(expect.any(String));
    expect(response.answer.length).toBeGreaterThan(0);
    expect(response.answer).not.toContain("24/7 phone support");
    expect(response.answerSegments).toEqual([
      expect.objectContaining({ text: expect.any(String), citationIndices: [0] }),
      expect.objectContaining({ text: "." }),
    ]);

    const [conversationId] = conversationRepository.items.keys();
    const persisted = await messageRepository.listByConversationId("workspace-1", conversationId!);
    expect(persisted.at(-1)?.content).toBe(response.answer);
  });

  it("keeps unsupported substantive content when answer support validation is disabled", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run() {
        return {
          rewrittenQuery: "what does this page do",
          contexts: [
            {
              chunkId: "chunk-1",
              documentId: "doc-1",
              title: "Guide",
              content: "The page explains testing and parsing content for users.",
            },
          ],
          prompt: "prompt text",
          citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Guide" }],
          diagnostics: {
            rewriteStatus: "skipped",
            rerankStatus: "skipped",
            originalCandidateCount: 1,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 1,
            normalizedCandidateCount: 1,
            finalContextCount: 1,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            parsedQuery: {
              semanticQuery: "page do",
              lexicalQuery: "page do",
              constraints: [],
            },
          },
          responseSettings: {
            citationDisplayEnabled: true,
            answerSupportValidationEnabled: false,
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer() {
        return "The page explains testing and parsing content for users[[1]]. It also offers 24/7 phone support.";
      },
      async *streamAnswer() {
        yield "unused";
      },
    };
    const service = new ChatService(
      conversationRepository,
      messageRepository,
      asChatRetrievalPipeline(retrievalPipeline) as never,
      chatGateway,
      auditService,
    );

    const response = await service.answer({
      workspaceId: "workspace-1",
      accountId: "account-1",
      query: "What does this page do?",
      stream: false,
    });

    expect(response.answer).toContain("24/7 phone support");
    expect(response.retrievalTrace.stages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stageId: "answer",
        outputs: expect.objectContaining({
          validationRan: false,
          answerModified: false,
        }),
      }),
    ]));
  });

  it("still plans grounded suggestions when answer support validation is disabled", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run() {
        return {
          rewrittenQuery: "what does the guide cover",
          contexts: [
            {
              chunkId: "chunk-1",
              documentId: "doc-1",
              title: "Guide",
              content: "The guide covers parser setup and onboarding workflows. It also explains import audits.",
            },
          ],
          prompt: "prompt text",
          citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Guide" }],
          diagnostics: {
            rewriteStatus: "skipped",
            rerankStatus: "skipped",
            originalCandidateCount: 1,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 1,
            normalizedCandidateCount: 1,
            finalContextCount: 1,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            parsedQuery: {
              semanticQuery: "guide cover",
              lexicalQuery: "guide cover",
              constraints: [],
            },
          },
          responseSettings: {
            citationDisplayEnabled: true,
            answerSupportValidationEnabled: false,
            conversationMode: "exploratory",
            suggestedQuestionsEnabled: true,
            suggestedQuestionsCount: 2,
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer({ prompt }) {
        if (prompt.includes("Generate grounded follow-up suggestions")) {
          return JSON.stringify({
            suggestions: [
              { text: "How do import audits work?", kind: "deeper", contextIndex: 1 },
            ],
          });
        }

        return "The guide covers parser setup and onboarding workflows[[1]].";
      },
      async *streamAnswer() {
        yield "unused";
      },
    };
    const service = new ChatService(
      conversationRepository,
      messageRepository,
      asChatRetrievalPipeline(retrievalPipeline) as never,
      chatGateway,
      auditService,
    );

    const response = await service.answer({
      workspaceId: "workspace-1",
      accountId: "account-1",
      query: "What does the guide cover?",
      stream: false,
    });

    expect(response.suggestions).toEqual([
      expect.objectContaining({
        text: "How do import audits work?",
        kind: "deeper",
        citation: {
          documentId: "doc-1",
          chunkId: "chunk-1",
          title: "Guide",
        },
      }),
    ]);
    expect(response.conversationModeMetadata).toEqual({
      conversationMode: "exploratory",
      brevityOverrideApplied: false,
      expansionApplied: true,
      expansionKind: "expansive",
      suggestionCount: 1,
      followUpQuestionApplied: false,
    });
    expect(response.retrievalTrace.stages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stageId: "answer",
        outputs: expect.objectContaining({
          validationRan: false,
        }),
      }),
    ]));
  });

  it("preserves assistant bootstrap claims alongside grounded document claims in non-streaming answers", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run() {
        return {
          rewrittenQuery: "what does this page do",
          contexts: [
            {
              chunkId: "chunk-1",
              documentId: "doc-1",
              title: "Guide",
              content: "The page explains testing and parsing content for users.",
            },
          ],
          prompt: "prompt text",
          citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Guide" }],
          responseIdentity: {
            name: "Vikram",
          },
          diagnostics: {
            rewriteStatus: "skipped",
            rerankStatus: "skipped",
            originalCandidateCount: 1,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 1,
            normalizedCandidateCount: 1,
            finalContextCount: 1,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            parsedQuery: {
              semanticQuery: "page do",
              lexicalQuery: "page do",
              constraints: [],
            },
          },
          responseSettings: {
            citationDisplayEnabled: true,
            conversationMode: "factual",
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer() {
        return "I'm Vikram. The page explains testing and parsing content for users.";
      },
      async *streamAnswer() {
        yield "unused";
      },
    };
    const service = new ChatService(
      conversationRepository,
      messageRepository,
      asChatRetrievalPipeline(retrievalPipeline) as never,
      chatGateway,
      auditService,
      groundedMissResponseComposer,
    );

    const response = await service.answer({
      workspaceId: "workspace-1",
      accountId: "account-1",
      query: "What does this page do?",
      stream: false,
    });

    expect(response.answer).toContain("Vikram");
    expect(response.answer).toContain("testing and parsing");
    expect(response.citations).toEqual([
      { documentId: "doc-1", chunkId: "chunk-1", title: "Guide" },
    ]);
    expect(response.answerSegments).toEqual([
      expect.objectContaining({ text: expect.any(String) }),
      expect.objectContaining({ text: expect.any(String), citationIndices: [0] }),
    ]);

    const [conversationId] = conversationRepository.items.keys();
    const persisted = await messageRepository.listByConversationId("workspace-1", conversationId!);
    expect(persisted.at(-1)?.content).toBe(response.answer);
  });

  it("streams provisional strict-mode chunks and still finishes with the validated final answer", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run() {
        return {
          rewrittenQuery: "what does this page do",
          contexts: [
            {
              chunkId: "chunk-1",
              documentId: "doc-1",
              title: "Guide",
              content: "The page explains testing and parsing content for users.",
            },
          ],
          prompt: "prompt text",
          citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Guide" }],
          diagnostics: {
            rewriteStatus: "skipped",
            rerankStatus: "skipped",
            originalCandidateCount: 1,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 1,
            normalizedCandidateCount: 1,
            finalContextCount: 1,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            parsedQuery: {
              semanticQuery: "page do",
              lexicalQuery: "page do",
              constraints: [],
            },
          },
          responseSettings: {
            citationDisplayEnabled: true,
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer() {
        return "unused";
      },
      async *streamAnswer() {
        yield "The page explains testing and parsing content for users[[1]]. ";
        yield "It also offers 24/7 phone support.";
      },
    };
    const service = new ChatService(
      conversationRepository,
      messageRepository,
      asChatRetrievalPipeline(retrievalPipeline) as never,
      chatGateway,
      auditService,
    );

    const iterator = service.streamAnswer({
      workspaceId: "workspace-1",
      accountId: "account-1",
      query: "What does this page do?",
      stream: true,
    })[Symbol.asyncIterator]();

    const conversationEvent = await iterator.next();

    expect(conversationEvent.value).toEqual({
      type: "conversation",
      conversationId: expect.any(String),
    });

    const events: ChatStreamEvent[] = [conversationEvent.value!];
    for await (const event of { [Symbol.asyncIterator]: () => iterator }) {
      events.push(event);
    }

    const streamedText = events
      .filter((event): event is Extract<ChatStreamEvent, { type: "chunk" }> => event.type === "chunk")
      .map((event) => event.text)
      .join("");

    expect(streamedText).toBe("The page explains testing and parsing content for users. It also offers 24/7 phone support.");
    expect(streamedText).toContain("24/7 phone support");
    expect(events.findIndex((event) => event.type === "chunk")).toBeGreaterThanOrEqual(0);
    expect(events.findIndex((event) => event.type === "chunk")).toBeLessThan(
      events.findIndex((event) => event.type === "done"),
    );
    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        type: "done",
        answer: "The page explains testing and parsing content for users.",
      }),
    );
  });

  it("continues incremental streaming under warn mode even when the final outcome is degraded", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run() {
        return {
          rewrittenQuery: "who is narayani",
          contexts: [
            {
              chunkId: "chunk-1",
              documentId: "doc-1",
              title: "Event listing",
              content: "Narayani leads a satsang this weekend.",
            },
          ],
          prompt: "prompt text",
          citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Event listing" }],
          diagnostics: {
            rewriteStatus: "skipped",
            rerankStatus: "skipped",
            originalCandidateCount: 1,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 1,
            normalizedCandidateCount: 1,
            finalContextCount: 1,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            parsedQuery: {
              semanticQuery: "who is narayani",
              lexicalQuery: "who is narayani",
              constraints: [],
            },
          },
          responseSettings: {
            citationDisplayEnabled: true,
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer() {
        return "unused";
      },
      async *streamAnswer() {
        yield "Narayani is a teacher";
        yield " and author.";
      },
    };
    const service = new ChatService(
      conversationRepository,
      messageRepository,
      asChatRetrievalPipeline(retrievalPipeline) as never,
      chatGateway,
      auditService,
    );

    const events: ChatStreamEvent[] = [];

    for await (const event of service.streamAnswer({
      workspaceId: "workspace-1",
      accountId: "account-1",
      query: "Who is Narayani?",
      stream: true,
    })) {
      events.push(event);
    }

    const chunkTexts = events
      .filter((event): event is Extract<ChatStreamEvent, { type: "chunk" }> => event.type === "chunk")
      .map((event) => event.text);

    expect(chunkTexts).toEqual(["Narayani is a teacher", " and author."]);
    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        type: "done",
        answer: expect.any(String),
        retrievalTrace: expect.objectContaining({
          stages: expect.arrayContaining([
            expect.objectContaining({
              stageId: "answer",
              kind: "answer_outcome",
              outputs: expect.objectContaining({
                outcome: "grounded_degraded_unsupported_segments",
              }),
            }),
          ]),
        }),
      }),
    );
  });

  it("does not infer expansion metadata from inline answer formatting", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run() {
        return {
          rewrittenQuery: "what does this page do",
          contexts: [
            {
              chunkId: "chunk-1",
              documentId: "doc-1",
              title: "Guide",
              content: "The page explains testing and parsing content for users. The FAQ covers onboarding. The notes cover examples.",
            },
          ],
          prompt: "prompt text",
          citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Guide" }],
          diagnostics: {
            rewriteStatus: "skipped",
            rerankStatus: "skipped",
            originalCandidateCount: 1,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 1,
            normalizedCandidateCount: 1,
            finalContextCount: 1,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            parsedQuery: {
              semanticQuery: "page do",
              lexicalQuery: "page do",
              constraints: [],
            },
          },
          responseSettings: {
            citationDisplayEnabled: true,
            conversationMode: "exploratory",
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer({ prompt }) {
        if (prompt.includes("Generate grounded follow-up suggestions")) {
          return '{"suggestions":[]}';
        }
        return [
          "The page explains testing and parsing content for users[[1]].",
          "",
          "- You can also inspect the onboarding FAQ[[1]].",
          "- The notes include worked examples[[1]].",
        ].join("\n");
      },
      async *streamAnswer() {
        yield "";
      },
    };
    const service = new ChatService(
      conversationRepository,
      messageRepository,
      asChatRetrievalPipeline(retrievalPipeline) as never,
      chatGateway,
      auditService,
      groundedMissResponseComposer,
    );

    const response = await service.answer({
      workspaceId: "workspace-1",
      accountId: "account-1",
      query: "What does this page do?",
      stream: false,
    });

    expect(response.conversationModeMetadata).toEqual({
      conversationMode: "exploratory",
      brevityOverrideApplied: false,
      expansionApplied: false,
      expansionKind: "none",
      suggestionCount: 0,
      followUpQuestionApplied: false,
    });
    expect(response.suggestions).toBeUndefined();
  });

  it("adds exploratory suggestions from grounded contexts when the direct answer stays terse", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run() {
        return {
          rewrittenQuery: "who is mahiya",
          contexts: [
            {
              chunkId: "chunk-1",
              documentId: "doc-1",
              title: "Mahiya",
              content: "Mahiya is a teacher and author.",
            },
            {
              chunkId: "chunk-2",
              documentId: "doc-2",
              title: "God is our True Home: In Conversation with Mahiya - Ananda Europe",
              content: "An interview about Mahiya's path and spiritual life.",
            },
            {
              chunkId: "chunk-3",
              documentId: "doc-3",
              title: "Il gusto della gioia - Ananda Edizioni - ricette, consigli e ispirazioni salutari",
              content: "Her cooking book and related work.",
            },
            {
              chunkId: "chunk-4",
              documentId: "doc-4",
              title: "Challenges and blessings go hand in hand - Interview with Mahiya (ENG) - Ananda Europe",
              content: "Another interview with adjacent material.",
            },
          ],
          prompt: "prompt text",
          citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Mahiya" }],
          diagnostics: {
            rewriteStatus: "skipped",
            rerankStatus: "skipped",
            originalCandidateCount: 4,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 4,
            normalizedCandidateCount: 4,
            finalContextCount: 4,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            parsedQuery: {
              semanticQuery: "who is mahiya",
              lexicalQuery: "mahiya",
              constraints: [],
            },
          },
          responseSettings: {
            citationDisplayEnabled: true,
            conversationMode: "exploratory",
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer({ prompt }) {
        if (prompt.includes("Generate grounded follow-up suggestions")) {
          return JSON.stringify({
            suggestions: [
              { text: "What does the interview say about Mahiya's spiritual path?", kind: "deeper", contextIndex: 1 },
              { text: "Which books or projects is Mahiya associated with?", kind: "broader", contextIndex: 2 },
              { text: "What challenges does Mahiya describe in the other interview?", kind: "broader", contextIndex: 3 },
            ],
          });
        }
        return "Mahiya is a teacher and author[[1]].";
      },
      async *streamAnswer() {
        yield "Mahiya is a teacher and author[[1]].";
      },
    };
    const service = new ChatService(
      conversationRepository,
      messageRepository,
      asChatRetrievalPipeline(retrievalPipeline) as never,
      chatGateway,
      auditService,
      groundedMissResponseComposer,
    );

    const response = await service.answer({
      workspaceId: "workspace-1",
      accountId: "account-1",
      query: "Who is Mahiya?",
      stream: false,
    });

    expect(response.answer).toEqual(expect.any(String));
    expect(response.answer.length).toBeGreaterThan(0);
    expect(response.answer).not.toContain("\n- ");
    expect(response.suggestions).toEqual([
      expect.objectContaining({
        text: expect.any(String),
        kind: "deeper",
        citation: expect.objectContaining({
          documentId: "doc-1",
        }),
      }),
      expect.objectContaining({
        text: expect.any(String),
        kind: "broader",
      }),
      expect.objectContaining({
        text: expect.any(String),
        kind: "broader",
      }),
    ]);
    expect(response.conversationModeMetadata).toEqual({
      conversationMode: "exploratory",
      brevityOverrideApplied: false,
      expansionApplied: true,
      expansionKind: "expansive",
      suggestionCount: 3,
      followUpQuestionApplied: false,
    });
    expect(response.citations).toEqual([
      { documentId: "doc-1", chunkId: "chunk-1", title: "Mahiya" },
    ]);
  });

  it("streams the answer before emitting grounded follow-up suggestions", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run() {
        return {
          rewrittenQuery: "who is mahiya",
          contexts: [
            {
              chunkId: "chunk-1",
              documentId: "doc-1",
              title: "Mahiya",
              content: "Mahiya is a teacher and author.",
            },
            {
              chunkId: "chunk-2",
              documentId: "doc-2",
              title: "Mahiya interview",
              content: "An interview about Mahiya's spiritual path.",
            },
          ],
          prompt: "prompt text",
          citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Mahiya" }],
          diagnostics: {
            rewriteStatus: "skipped",
            rerankStatus: "skipped",
            originalCandidateCount: 2,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 2,
            normalizedCandidateCount: 2,
            finalContextCount: 2,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            parsedQuery: {
              semanticQuery: "who is mahiya",
              lexicalQuery: "mahiya",
              constraints: [],
            },
          },
          responseSettings: {
            citationDisplayEnabled: true,
            conversationMode: "exploratory",
            suggestedQuestionsEnabled: true,
            suggestedQuestionsCount: 2,
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer({ prompt }) {
        if (prompt.includes("Generate grounded follow-up suggestions")) {
          return JSON.stringify({
            suggestions: [
              { text: "What does the interview say about Mahiya's spiritual path?", contextIndex: 1 },
            ],
          });
        }
        return "Mahiya is a teacher and author[[1]].";
      },
      async *streamAnswer() {
        yield "Mahiya is a teacher and author[[1]].";
      },
    };
    const service = new ChatService(
      conversationRepository,
      messageRepository,
      asChatRetrievalPipeline(retrievalPipeline) as never,
      chatGateway,
      auditService,
      groundedMissResponseComposer,
    );

    const events: ChatStreamEvent[] = [];

    for await (const event of service.streamAnswer({
      workspaceId: "workspace-1",
      accountId: "account-1",
      query: "Who is Mahiya?",
      stream: true,
    })) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual(["conversation", "chunk", "done", "suggestions"]);
    expect(events[2]).toMatchObject({
      type: "done",
      answer: "Mahiya is a teacher and author.",
      suggestions: undefined,
      conversationModeMetadata: {
        conversationMode: "exploratory",
        brevityOverrideApplied: false,
        expansionApplied: false,
        expansionKind: "none",
        suggestionCount: 0,
        followUpQuestionApplied: false,
      },
    });
    expect(events[3]).toMatchObject({
      type: "suggestions",
      suggestions: [
        {
          text: "What does the interview say about Mahiya's spiritual path?",
          citation: {
            documentId: "doc-1",
            chunkId: "chunk-1",
            title: "Mahiya",
          },
        },
      ],
      conversationModeMetadata: {
        conversationMode: "exploratory",
        brevityOverrideApplied: false,
        expansionApplied: true,
        expansionKind: "expansive",
        suggestionCount: 1,
        followUpQuestionApplied: false,
      },
    });
  });

  it("does not convert a completed answer into a failure when lazy suggestions fail", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditEventRepository = new InMemoryAuditEventRepository();
    const auditService = createAuditService(auditEventRepository);
    const retrievalPipeline = {
      async run() {
        return {
          rewrittenQuery: "who is mahiya",
          contexts: [
            {
              chunkId: "chunk-1",
              documentId: "doc-1",
              title: "Mahiya",
              content: "Mahiya is a teacher and author.",
            },
          ],
          prompt: "prompt text",
          citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Mahiya" }],
          diagnostics: {
            rewriteStatus: "skipped",
            rerankStatus: "skipped",
            originalCandidateCount: 1,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 1,
            normalizedCandidateCount: 1,
            finalContextCount: 1,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            parsedQuery: {
              semanticQuery: "who is mahiya",
              lexicalQuery: "mahiya",
              constraints: [],
            },
          },
          responseSettings: {
            citationDisplayEnabled: true,
            conversationMode: "exploratory",
            suggestedQuestionsEnabled: true,
            suggestedQuestionsCount: 2,
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer({ prompt }) {
        if (prompt.includes("Generate grounded follow-up suggestions")) {
          throw new Error("suggestions unavailable");
        }
        return "Mahiya is a teacher and author[[1]].";
      },
      async *streamAnswer() {
        yield "Mahiya is a teacher and author[[1]].";
      },
    };
    const service = new ChatService(
      conversationRepository,
      messageRepository,
      asChatRetrievalPipeline(retrievalPipeline) as never,
      chatGateway,
      auditService,
      groundedMissResponseComposer,
    );

    const events: ChatStreamEvent[] = [];

    for await (const event of service.streamAnswer({
      workspaceId: "workspace-1",
      accountId: "account-1",
      query: "Who is Mahiya?",
      stream: true,
    })) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual(["conversation", "chunk", "done"]);
    expect(auditEventRepository.items.filter((event) => event.eventType === "chat.answer")).toHaveLength(1);
    expect(auditEventRepository.items[0]?.eventStatus).toBe("success");
  });

  it("returns exploratory suggestions as structured multilingual continuations", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run() {
        return {
          rewrittenQuery: "quali libri ha scritto narayani",
          contexts: [
            {
              chunkId: "chunk-1",
              documentId: "doc-1",
              title: "Narayani Anaya Archivi - Ananda Edizioni",
              content: "Narayani wrote La mia anima ricorda Swami Kriyananda.",
            },
            {
              chunkId: "chunk-2",
              documentId: "doc-2",
              title: "Satsang with Narayani (on her upcoming book and more) &mdash; Ananda",
              content: "An event about her upcoming book and more.",
            },
          ],
          prompt: "prompt text",
          citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Narayani Anaya Archivi - Ananda Edizioni" }],
          diagnostics: {
            rewriteStatus: "skipped",
            rerankStatus: "skipped",
            originalCandidateCount: 2,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 2,
            normalizedCandidateCount: 2,
            finalContextCount: 2,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            parsedQuery: {
              semanticQuery: "quali libri ha scritto narayani",
              lexicalQuery: "narayani libri",
              constraints: [],
            },
          },
          responseSettings: {
            citationDisplayEnabled: true,
            conversationMode: "exploratory",
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer({ prompt }) {
        if (prompt.includes("Generate grounded follow-up suggestions")) {
          return JSON.stringify({
            suggestions: [
              { text: "Quale altro libro o progetto è collegato a Narayani?", kind: "broader", contextIndex: 1 },
            ],
          });
        }
        return "Narayani ha scritto La mia anima ricorda Swami Kriyananda[[1]].";
      },
      async *streamAnswer() {
        yield "Narayani ha scritto La mia anima ricorda Swami Kriyananda[[1]].";
      },
    };
    const service = new ChatService(
      conversationRepository,
      messageRepository,
      asChatRetrievalPipeline(retrievalPipeline) as never,
      chatGateway,
      auditService,
      groundedMissResponseComposer,
    );

    const response = await service.answer({
      workspaceId: "workspace-1",
      accountId: "account-1",
      query: "quali libri ha scritto Narayani",
      stream: false,
    });

    expect(response.answer).toEqual(expect.any(String));
    expect(response.answer.length).toBeGreaterThan(0);
    expect(response.suggestions).toEqual([
      expect.objectContaining({
        text: expect.any(String),
        kind: "broader",
        citation: expect.objectContaining({
          documentId: "doc-1",
        }),
      }),
    ]);
  });

  it("filters suggestions that mostly restate the current query or answer", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run() {
        return {
          rewrittenQuery: "want links to the next page of assisi videos",
          contexts: [
            {
              chunkId: "chunk-1",
              documentId: "doc-1",
              title: "Assisi Archives - Page 2 of 14 - Ananda Europe",
              content: "Page 2 links to the next page in the archive.",
            },
            {
              chunkId: "chunk-2",
              documentId: "doc-2",
              title: "Assisi Archives - Page 3 of 14 - Ananda Europe",
              content: "Page 3 is part of a 14-page archive.",
            },
          ],
          prompt: "prompt text",
          citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Assisi Archives - Page 2 of 14 - Ananda Europe" }],
          diagnostics: {
            rewriteStatus: "skipped",
            rerankStatus: "skipped",
            originalCandidateCount: 2,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 2,
            normalizedCandidateCount: 2,
            finalContextCount: 2,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            parsedQuery: {
              semanticQuery: "assisi videos next page",
              lexicalQuery: "assisi videos page 3",
              constraints: [],
            },
          },
          responseSettings: {
            citationDisplayEnabled: true,
            conversationMode: "exploratory",
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer({ prompt }) {
        if (prompt.includes("Generate grounded follow-up suggestions")) {
          return JSON.stringify({
            suggestions: [
              { text: "What videos are on page 3?", kind: "deeper", contextIndex: 2 },
              { text: "How many Assisi archive pages are there?", kind: "broader", contextIndex: 2 },
            ],
          });
        }

        return "Yes — here's the next page of the Assisi videos archive: https://anandaeurope.org/category/video-from-assisi/page/3/[[1]]";
      },
      async *streamAnswer() {
        yield "Yes — here's the next page of the Assisi videos archive: https://anandaeurope.org/category/video-from-assisi/page/3/[[1]]";
      },
    };
    const service = new ChatService(
      conversationRepository,
      messageRepository,
      asChatRetrievalPipeline(retrievalPipeline) as never,
      chatGateway,
      auditService,
      groundedMissResponseComposer,
    );

    const response = await service.answer({
      workspaceId: "workspace-1",
      accountId: "account-1",
      query: "Want links to the next page of Assisi videos?",
      stream: false,
    });

    expect(response.suggestions).toEqual([
      expect.objectContaining({
        text: expect.any(String),
        kind: "broader",
        citation: expect.objectContaining({
          documentId: "doc-2",
        }),
      }),
    ]);
  });

  it("feeds recent conversation context into exploratory suggestion planning", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run({ query }: { query: string }) {
        return {
          rewrittenQuery: query.toLowerCase(),
          contexts: [
            {
              chunkId: "chunk-1",
              documentId: "doc-1",
              title: "Retreat Planning Guide",
              content: "A beginner retreat should cover meditation, schedule planning, meals, and orientation.",
            },
            {
              chunkId: "chunk-2",
              documentId: "doc-2",
              title: "Retreat Facilitation Notes",
              content: "Facilitators should balance logistics, teaching goals, and attendee support.",
            },
          ],
          prompt: "prompt text",
          citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Retreat Planning Guide" }],
          diagnostics: {
            rewriteStatus: "skipped",
            rerankStatus: "skipped",
            originalCandidateCount: 2,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 2,
            normalizedCandidateCount: 2,
            finalContextCount: 2,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            parsedQuery: {
              semanticQuery: query.toLowerCase(),
              lexicalQuery: query.toLowerCase(),
              constraints: [],
            },
          },
          responseSettings: {
            citationDisplayEnabled: true,
            conversationMode: "exploratory",
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer({ prompt, query }) {
        if (prompt.includes("Generate grounded follow-up suggestions")) {
          return JSON.stringify({
            suggestions: [
              { text: "What should a beginner retreat schedule include?", kind: "deeper", contextIndex: 1 },
              { text: "How should retreat facilitators support attendees?", kind: "broader", contextIndex: 2 },
            ],
          });
        }

        if (query === "What should I include next?") {
          return "You should include orientation and meals[[1]].";
        }

        return "Start with a beginner retreat schedule[[1]].";
      },
      async *streamAnswer() {
        yield "";
      },
    };
    const service = new ChatService(
      conversationRepository,
      messageRepository,
      asChatRetrievalPipeline(retrievalPipeline) as never,
      chatGateway,
      auditService,
      groundedMissResponseComposer,
    );

    const first = await service.answer({
      workspaceId: "workspace-1",
      accountId: "account-1",
      query: "Help me plan a beginner retreat",
      stream: false,
    });
    const second = await service.answer({
      workspaceId: "workspace-1",
      accountId: "account-1",
      conversationId: first.conversationId,
      query: "What should I include next?",
      stream: false,
    });

    expect(second.suggestions).toEqual([
      expect.objectContaining({
        text: expect.any(String),
        kind: "deeper",
        citation: expect.objectContaining({
          documentId: "doc-1",
        }),
      }),
      expect.objectContaining({
        text: expect.any(String),
        kind: "broader",
        citation: expect.objectContaining({
          documentId: "doc-2",
        }),
      }),
    ]);
  });

  it("recenters exploratory planning when the user explicitly pivots subjects", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run({ query }: { query: string }) {
        const pivotTurn = query === "What about facilitator support?";
        return {
          rewrittenQuery: pivotTurn ? "facilitator support" : "plan a beginner retreat",
          contexts: pivotTurn
            ? [
                {
                    chunkId: "chunk-2",
                    documentId: "doc-2",
                    title: "Retreat Facilitation Notes",
                    content: "Facilitators should balance logistics, teaching goals, and attendee support.",
                },
                {
                    chunkId: "chunk-3",
                    documentId: "doc-3",
                    title: "Retreat Support Roles",
                    content: "Support roles include hospitality, orientation, and attendee care.",
                },
              ]
            : [
                {
                    chunkId: "chunk-1",
                    documentId: "doc-1",
                    title: "Retreat Planning Guide",
                    content: "A beginner retreat should cover meditation, schedule planning, meals, and orientation.",
                },
                {
                    chunkId: "chunk-2",
                    documentId: "doc-2",
                    title: "Retreat Facilitation Notes",
                    content: "Facilitators should balance logistics, teaching goals, and attendee support.",
                },
              ],
          prompt: "prompt text",
          citations: [
            pivotTurn
              ? { documentId: "doc-2", chunkId: "chunk-2", title: "Retreat Facilitation Notes" }
              : { documentId: "doc-1", chunkId: "chunk-1", title: "Retreat Planning Guide" },
          ],
          diagnostics: {
            rewriteStatus: "applied",
            rerankStatus: "skipped",
            originalCandidateCount: 2,
            rewrittenCandidateCount: 1,
            lexicalCandidateCount: 2,
            normalizedCandidateCount: 2,
            finalContextCount: 2,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            parsedQuery: {
              semanticQuery: query.toLowerCase(),
              lexicalQuery: query.toLowerCase(),
              constraints: [],
            },
            rewriteProposal: pivotTurn
              ? {
                  rewrittenQuery: "facilitator support",
                  semanticQuery: "facilitator support retreat attendees",
                  lexicalQuery: "facilitator support",
                  turnKind: "explicit_recenter",
                  proposedActiveSubject: "Facilitator support",
                  relatedEntities: [],
                  unresolved: false,
                  confidence: 0.97,
                }
              : {
                  rewrittenQuery: "plan a beginner retreat",
                  semanticQuery: "beginner retreat planning",
                  lexicalQuery: "beginner retreat planning",
                  turnKind: "fresh_subject",
                  proposedActiveSubject: "Beginner retreat planning",
                  relatedEntities: [],
                  unresolved: false,
                  confidence: 0.94,
                },
          },
          responseSettings: {
            citationDisplayEnabled: true,
            conversationMode: "exploratory",
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer({ prompt, query }) {
        if (prompt.includes("Generate grounded follow-up suggestions")) {
          if (prompt.includes("Active subject:\nFacilitator support")) {
            return JSON.stringify({
              suggestions: [
                { text: "How should facilitators support retreat attendees?", kind: "deeper", contextIndex: 1 },
                { text: "Which support roles should back up retreat facilitators?", kind: "broader", contextIndex: 2 },
              ],
            });
          }

          return JSON.stringify({
            suggestions: [
              { text: "What should a beginner retreat schedule include?", kind: "deeper", contextIndex: 1 },
              { text: "How should retreat facilitators support attendees?", kind: "broader", contextIndex: 2 },
            ],
          });
        }

        if (query === "What about facilitator support?") {
          return "Facilitators should balance logistics and attendee care[[1]].";
        }

        return "Start with a beginner retreat schedule[[1]].";
      },
      async *streamAnswer() {
        yield "";
      },
    };
    const service = new ChatService(
      conversationRepository,
      messageRepository,
      asChatRetrievalPipeline(retrievalPipeline) as never,
      chatGateway,
      auditService,
      groundedMissResponseComposer,
    );

    const first = await service.answer({
      workspaceId: "workspace-1",
      accountId: "account-1",
      query: "Help me plan a beginner retreat",
      stream: false,
    });
    const second = await service.answer({
      workspaceId: "workspace-1",
      accountId: "account-1",
      conversationId: first.conversationId,
      query: "What about facilitator support?",
      stream: false,
    });

    expect(second.suggestions).toEqual([
      expect.objectContaining({
        text: expect.any(String),
        kind: "deeper",
        citation: expect.objectContaining({
          documentId: "doc-2",
        }),
      }),
      expect.objectContaining({
        text: expect.any(String),
        kind: "broader",
        citation: expect.objectContaining({
          documentId: "doc-3",
        }),
      }),
    ]);
  });

  it("does not suppress exploratory suggestions from language-specific directness wording", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run() {
        return {
          rewrittenQuery: "just the answer what does the guide cover",
          contexts: [
            {
              chunkId: "chunk-1",
              documentId: "doc-1",
              title: "Guide",
              content: "The guide covers testing, onboarding, and parser rules.",
            },
          ],
          prompt: "prompt text",
          citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Guide" }],
          diagnostics: {
            rewriteStatus: "skipped",
            rerankStatus: "skipped",
            originalCandidateCount: 1,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 1,
            normalizedCandidateCount: 1,
            finalContextCount: 1,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            parsedQuery: {
              semanticQuery: "guide cover",
              lexicalQuery: "guide cover",
              constraints: [],
            },
          },
          responseSettings: {
            citationDisplayEnabled: true,
            conversationMode: "exploratory",
          },
        };
      },
    } as const;
    let suggestionCallCount = 0;
    const chatGateway: ChatGateway = {
      async answer({ prompt }) {
        if (prompt.includes("Generate grounded follow-up suggestions")) {
          suggestionCallCount += 1;
          return JSON.stringify({
            suggestions: [
              { text: "How should teams apply these rules?", kind: "deeper", contextIndex: 1 },
              { text: "What setup examples are available?", kind: "deeper", contextIndex: 1 },
              { text: "Which workflow risks should I compare?", kind: "broader", contextIndex: 1 },
            ],
          });
        }

        return "The guide covers testing, onboarding, and parser rules[[1]].";
      },
      async *streamAnswer() {
        yield "";
      },
    };
    const service = new ChatService(
      conversationRepository,
      messageRepository,
      asChatRetrievalPipeline(retrievalPipeline) as never,
      chatGateway,
      auditService,
      groundedMissResponseComposer,
    );

    const response = await service.answer({
      workspaceId: "workspace-1",
      accountId: "account-1",
      query: "Just the answer: what does the guide cover?",
      stream: false,
    });

    expect(suggestionCallCount).toBe(1);
    expect(response.suggestions).toEqual([
      expect.objectContaining({
        text: "How should teams apply these rules?",
        kind: "deeper",
      }),
      expect.objectContaining({
        text: "What setup examples are available?",
        kind: "deeper",
      }),
      expect.objectContaining({
        text: "Which workflow risks should I compare?",
        kind: "broader",
      }),
    ]);
    expect(response.conversationModeMetadata).toEqual({
      conversationMode: "exploratory",
      brevityOverrideApplied: false,
      expansionApplied: true,
      expansionKind: "expansive",
      suggestionCount: 3,
      followUpQuestionApplied: false,
    });
  });

  it("drops invalid grouped suggestions and removes duplicates across lanes", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run() {
        return {
          rewrittenQuery: "what does the archive cover",
          contexts: [
            {
              chunkId: "chunk-1",
              documentId: "doc-1",
              title: "Archive Guide",
              content: "The archive covers videos, audio, and retreat notes.",
            },
            {
              chunkId: "chunk-2",
              documentId: "doc-2",
              title: "Archive Notes",
              content: "The notes explain how the archive is organized.",
            },
          ],
          prompt: "prompt text",
          citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Archive Guide" }],
          diagnostics: {
            rewriteStatus: "skipped",
            rerankStatus: "skipped",
            originalCandidateCount: 2,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 2,
            normalizedCandidateCount: 2,
            finalContextCount: 2,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            parsedQuery: {
              semanticQuery: "archive cover",
              lexicalQuery: "archive cover",
              constraints: [],
            },
          },
          responseSettings: {
            citationDisplayEnabled: true,
            conversationMode: "exploratory",
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer({ prompt }) {
        if (prompt.includes("Generate grounded follow-up suggestions")) {
          return JSON.stringify({
            suggestions: [
              { text: "What does the archive cover?", kind: "deeper", contextIndex: 1 },
              { text: "How is the archive organized?", kind: "broader", contextIndex: 2 },
              { text: "How is the archive organized?", kind: "deeper", contextIndex: 2 },
              { text: "Which archive videos are available?", kind: "invalid_kind", contextIndex: 1 },
            ],
          });
        }

        return "The archive covers videos, audio, and retreat notes[[1]].";
      },
      async *streamAnswer() {
        yield "";
      },
    };
    const service = new ChatService(
      conversationRepository,
      messageRepository,
      asChatRetrievalPipeline(retrievalPipeline) as never,
      chatGateway,
      auditService,
      groundedMissResponseComposer,
    );

    const response = await service.answer({
      workspaceId: "workspace-1",
      accountId: "account-1",
      query: "What does the archive cover?",
      stream: false,
    });

    expect(response.suggestions).toEqual([
      expect.objectContaining({
        text: expect.any(String),
        kind: "broader",
        citation: expect.objectContaining({
          documentId: "doc-2",
        }),
      }),
    ]);
  });

  it("preserves a broader lane when valid broader suggestions arrive after deeper ones", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run() {
        return {
          rewrittenQuery: "retreat planning",
          contexts: [
            {
              chunkId: "chunk-1",
              documentId: "doc-1",
              title: "Retreat Planning Guide",
              content: "The guide covers schedules, meals, and orientation.",
            },
            {
              chunkId: "chunk-2",
              documentId: "doc-2",
              title: "Retreat Meal Guide",
              content: "Meals should fit the retreat schedule and attendee needs.",
            },
            {
              chunkId: "chunk-3",
              documentId: "doc-3",
              title: "Retreat Orientation Guide",
              content: "Orientation should set expectations and welcome attendees.",
            },
            {
              chunkId: "chunk-4",
              documentId: "doc-4",
              title: "Retreat Facilitation Notes",
              content: "Facilitators should support attendee logistics and questions.",
            },
          ],
          prompt: "prompt text",
          citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Retreat Planning Guide" }],
          diagnostics: {
            rewriteStatus: "skipped",
            rerankStatus: "skipped",
            originalCandidateCount: 4,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 4,
            normalizedCandidateCount: 4,
            finalContextCount: 4,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            parsedQuery: {
              semanticQuery: "retreat planning",
              lexicalQuery: "retreat planning",
              constraints: [],
            },
          },
          responseSettings: {
            citationDisplayEnabled: true,
            conversationMode: "exploratory",
            suggestedQuestionsCount: 3,
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer({ prompt }) {
        if (prompt.includes("Generate grounded follow-up suggestions")) {
          return JSON.stringify({
            suggestions: [
              { text: "What should the retreat schedule include?", kind: "deeper", contextIndex: 1 },
              { text: "How should retreat meals fit the schedule?", kind: "deeper", contextIndex: 2 },
              { text: "What should orientation cover on day one?", kind: "deeper", contextIndex: 3 },
              { text: "How should facilitators support retreat attendees?", kind: "broader", contextIndex: 4 },
            ],
          });
        }

        return "Start with the retreat schedule and day-one orientation[[1]].";
      },
      async *streamAnswer() {
        yield "";
      },
    };
    const service = new ChatService(
      conversationRepository,
      messageRepository,
      asChatRetrievalPipeline(retrievalPipeline) as never,
      chatGateway,
      auditService,
      groundedMissResponseComposer,
    );

    const response = await service.answer({
      workspaceId: "workspace-1",
      accountId: "account-1",
      query: "Help me plan a retreat",
      stream: false,
    });

    expect(response.suggestions).toEqual([
      expect.objectContaining({
        text: expect.any(String),
        kind: "deeper",
        citation: expect.objectContaining({
          documentId: "doc-1",
        }),
      }),
      expect.objectContaining({
        text: expect.any(String),
        kind: "broader",
        citation: expect.objectContaining({
          documentId: "doc-4",
        }),
      }),
      expect.objectContaining({
        text: expect.any(String),
        kind: "deeper",
        citation: expect.objectContaining({
          documentId: "doc-2",
        }),
      }),
    ]);
  });

  it("preserves grounded markdown links while dropping uncited wrappers during strict validation", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run() {
        return {
          rewrittenQuery: "where can i read more",
          contexts: [
            {
              chunkId: "chunk-1",
              documentId: "doc-1",
              title: "Guide",
              content: "The page explains testing and parsing content for users.",
              metadata: {
                sourceUrl: "https://example.com/guide",
              },
            },
          ],
          prompt: "prompt text",
          citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Guide" }],
          diagnostics: {
            rewriteStatus: "skipped",
            rerankStatus: "skipped",
            originalCandidateCount: 1,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 1,
            normalizedCandidateCount: 1,
            finalContextCount: 1,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            parsedQuery: {
              semanticQuery: "read more",
              lexicalQuery: "read more",
              constraints: [],
            },
          },
          responseSettings: {
            citationDisplayEnabled: true,
            conversationMode: "guided",
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer() {
        return "Read more here: [Guide](https://example.com/guide)";
      },
      async *streamAnswer() {
        yield "";
      },
    };
    const service = new ChatService(
      conversationRepository,
      messageRepository,
      asChatRetrievalPipeline(retrievalPipeline) as never,
      chatGateway,
      auditService,
      groundedMissResponseComposer,
    );

    const response = await service.answer({
      workspaceId: "workspace-1",
      query: "Where can I read more?",
      stream: false,
    });

    expect(response.answer).toEqual(expect.any(String));
    expect(response.answer).toContain("Guide");
    expect(response.citations).toEqual([
      { documentId: "doc-1", chunkId: "chunk-1", title: "Guide" },
    ]);
    expect(response.answerSegments).toEqual([
      {
        text: expect.any(String),
        citationIndices: [0],
      },
    ]);
  });

  it("preserves model-authored unsupported notices marked for strict validation", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run() {
        return {
          rewrittenQuery: "precio del curso",
          contexts: [
            {
              chunkId: "chunk-1",
              documentId: "doc-1",
              title: "Programa",
              content: "El programa describe el curso, pero no incluye precios.",
            },
          ],
          prompt: "prompt text",
          citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Programa" }],
          diagnostics: {
            rewriteStatus: "skipped",
            rerankStatus: "skipped",
            originalCandidateCount: 1,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 1,
            normalizedCandidateCount: 1,
            finalContextCount: 1,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            parsedQuery: {
              semanticQuery: "precio curso",
              lexicalQuery: "precio curso",
              constraints: [],
            },
          },
          responseSettings: {
            citationDisplayEnabled: true,
            conversationMode: "guided",
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer() {
        return "No puedo verificar ese precio con lo que tengo aquí.<<UNSUPPORTED>>";
      },
      async *streamAnswer() {
        yield "";
      },
    };
    const fallbackComposer: GroundedMissResponseComposer = {
      async composeUnsupportedWithContext() {
        return 'I could not verify that from your workspace documents.';
      },
      async composeNoContext() {
        return 'I could not find supporting material.';
      },
    };
    const service = new ChatService(
      conversationRepository,
      messageRepository,
      asChatRetrievalPipeline(retrievalPipeline) as never,
      chatGateway,
      auditService,
      fallbackComposer,
    );

    const response = await service.answer({
      workspaceId: "workspace-1",
      query: "Cual es el precio del curso?",
      stream: false,
      userExpectedLocale: "es-ES",
    });

    expect(response.answer).toEqual(expect.any(String));
    expect(response.answer.length).toBeGreaterThan(0);
    expect(response.citations).toEqual([]);
    expect(response.answerSegments).toEqual([
      {
        text: expect.any(String),
      },
    ]);
  });

  it("strips unsupported notice markers from streamed chunks and final answers", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run() {
        return {
          rewrittenQuery: "precio del curso",
          contexts: [
            {
              chunkId: "chunk-1",
              documentId: "doc-1",
              title: "Programa",
              content: "El programa describe el curso, pero no incluye precios.",
            },
          ],
          prompt: "prompt text",
          citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Programa" }],
          diagnostics: {
            rewriteStatus: "skipped",
            rerankStatus: "skipped",
            originalCandidateCount: 1,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 1,
            normalizedCandidateCount: 1,
            finalContextCount: 1,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            parsedQuery: {
              semanticQuery: "precio curso",
              lexicalQuery: "precio curso",
              constraints: [],
            },
          },
          responseSettings: {
            citationDisplayEnabled: true,
            conversationMode: "guided",
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer() {
        return "unused";
      },
      async *streamAnswer() {
        yield "No puedo verificar ese precio";
        yield " con lo que tengo aquí.<<UNSUP";
        yield "PORTED>>";
      },
    };
    const service = new ChatService(
      conversationRepository,
      messageRepository,
      asChatRetrievalPipeline(retrievalPipeline) as never,
      chatGateway,
      auditService,
      groundedMissResponseComposer,
    );

    const events: ChatStreamEvent[] = [];
    for await (const event of service.streamAnswer({
      workspaceId: "workspace-1",
      query: "Cual es el precio del curso?",
      stream: true,
      userExpectedLocale: "es-ES",
    })) {
      events.push(event);
    }

    expect(events.filter((event) => event.type === "chunk")).toEqual([
      { type: "chunk", text: expect.any(String) },
      { type: "chunk", text: expect.any(String) },
    ]);
    expect(events.at(-1)).toEqual(expect.objectContaining({
      type: "done",
      answer: expect.any(String),
    }));
  });

  it("routes social-only turns through the non-retrieval path and keeps answer instructions available", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    let groundedMissCalls = 0;
    let observedPrompt = "";
    let runInterpretedCalls = 0;
    let runWithoutRetrievalCalls = 0;

    const retrievalPipeline = {
      async run() {
        throw new Error("run should not be used when intent routing is available");
      },
      async interpret() {
        return {
          request: {
            workspaceId: "workspace-1",
            query: "Thanks for the help",
            history: [],
            responseIdentity: {
              name: "Vikram",
            },
          },
          traceStartedAtMs: Date.now(),
          context: {
            startedAt: Date.now(),
            durationMs: 1,
            result: {
              request: {
                workspaceId: "workspace-1",
                query: "Thanks for the help",
                history: [],
                responseIdentity: {
                  name: "Vikram",
                },
              },
              settings: {
                workspaceId: "workspace-1",
                queryRewriteEnabled: true,
                semanticRewriteInstructions: "",
                lexicalRewriteInstructions: "",
                conversationMode: "guided",
                suggestedQuestionsEnabled: true,
                suggestedQuestionsCount: 3,
                rerankEnabled: false,
                vectorTopK: 20,
                similarityThreshold: 0.1,
                rerankTopK: 5,
                citationDisplayEnabled: true,
                customInstruction: "Keep the tone calm and welcoming.",
                metadataRules: [],
                createdAt: new Date(),
                updatedAt: new Date(),
              },
              contextWindow: {
                selectedMessages: [],
                truncated: false,
                selectionReason: "full-history",
              },
            },
          },
          interpretation: {
            startedAt: Date.now(),
            durationMs: 1,
            result: {
              responseIntent: "social_only",
            },
          },
        };
      },
      async runInterpreted() {
        runInterpretedCalls += 1;
        throw new Error("runInterpreted should not be used for social-only turns");
      },
      async runWithoutRetrieval() {
        runWithoutRetrievalCalls += 1;
        return {
          rewrittenQuery: "Thanks for the help",
          contexts: [],
          prompt: "",
          citations: [],
          responseIdentity: {
            name: "Vikram",
          },
          responseSettings: {
            citationDisplayEnabled: true,
            conversationMode: "guided",
            suggestedQuestionsEnabled: true,
            suggestedQuestionsCount: 3,
            customInstruction: "Keep the tone calm and welcoming.",
            responseLanguagePolicy: "match_user_question",
          },
          diagnostics: {
            rewriteStatus: "applied",
            rerankStatus: "skipped",
            originalCandidateCount: 0,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 0,
            normalizedCandidateCount: 0,
            finalContextCount: 0,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            responseIntent: "social_only",
            retrievalSkipped: true,
            intentConfidence: 0.96,
            intentFallbackApplied: false,
            parsedQuery: {
              originalQuery: "Thanks for the help",
              semanticQuery: "Thanks for the help",
              lexicalQuery: "Thanks for the help",
              constraints: [],
            },
            triggerAnalysis: {
              status: "skipped_non_retrieval",
              consideredRules: [],
              matchedRuleIds: [],
              unmatchedRuleIds: [],
              matchCount: 0,
              matcherVersion: "non_retrieval",
            },
          },
          trace: {
            traceId: "trace-1",
            startedAt: new Date().toISOString(),
            stages: [
              { stageId: "diagnostics", kind: "diagnostics", label: "Diagnostics", status: "skipped" },
            ],
            links: [],
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer({ prompt }) {
        observedPrompt = prompt;
        return "Thanks. Ask me about retreats or courses when you're ready.";
      },
      async *streamAnswer() {
        yield "unused";
      },
    };
    const fallbackComposer: GroundedMissResponseComposer = {
      async composeUnsupportedWithContext() {
        return "unused";
      },
      async composeNoContext() {
        groundedMissCalls += 1;
        return "I couldn't find supporting material.";
      },
    };
    const service = new ChatService(
      conversationRepository,
      messageRepository,
      asChatRetrievalPipeline(retrievalPipeline) as never,
      chatGateway,
      auditService,
      fallbackComposer,
    );

    const response = await service.answer({
      workspaceId: "workspace-1",
      query: "Thanks for the help",
      stream: false,
    });

    expect(response.answer).toBe("Thanks. Ask me about retreats or courses when you're ready.");
    expect(response.route).toEqual({
      type: "direct",
      reason: "social_only",
    });
    expect(response.citations).toBeUndefined();
    expect(response.retrievalInfo).toMatchObject({
      responseIntent: "social_only",
      retrievalSkipped: true,
      intentConfidence: 0.96,
    });
    expect(response.retrievalTrace.stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stageId: "answer",
          status: "applied",
          outputs: expect.objectContaining({
            retrievalSkipped: true,
          }),
        }),
      ]),
    );
    expect(observedPrompt).toContain("Keep the tone calm and welcoming.");
    expect(observedPrompt).toContain("Stable assistant identity:");
    expect(observedPrompt).toContain("Vikram");
    expect(observedPrompt).toContain("Conversation mode: guided.");
    expect(groundedMissCalls).toBe(0);
    expect(runWithoutRetrievalCalls).toBe(1);
    expect(runInterpretedCalls).toBe(0);
    expect(auditService.events).toContainEqual(
      expect.objectContaining({
        eventType: "chat.answer",
        eventStatus: "success",
        metadata: expect.objectContaining({
          answerOutcome: "non_retrieval_response",
          route: expect.objectContaining({
            generator: "assistant",
            routeType: "direct",
            routeReason: "social_only",
            retrievalInvoked: false,
          }),
        }),
      }),
    );
  });

  it("routes assistant-identity turns through the same non-retrieval path without regex checks", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    let observedPrompt = "";

    const retrievalPipeline = {
      async run() {
        throw new Error("run should not be used when intent routing is available");
      },
      async interpret() {
        return {
          request: {
            workspaceId: "workspace-1",
            query: "Remind me what you do around here",
            history: [],
            responseIdentity: {
              name: "Vikram",
            },
          },
          traceStartedAtMs: Date.now(),
          context: {
            startedAt: Date.now(),
            durationMs: 1,
            result: {
              request: {
                workspaceId: "workspace-1",
                query: "Remind me what you do around here",
                history: [],
                responseIdentity: {
                  name: "Vikram",
                },
              },
              settings: {
                workspaceId: "workspace-1",
                queryRewriteEnabled: true,
                semanticRewriteInstructions: "",
                lexicalRewriteInstructions: "",
                conversationMode: "guided",
                suggestedQuestionsEnabled: true,
                suggestedQuestionsCount: 3,
                rerankEnabled: false,
                vectorTopK: 20,
                similarityThreshold: 0.1,
                rerankTopK: 5,
                citationDisplayEnabled: true,
                customInstruction: "Keep the reply brief.",
                metadataRules: [],
                createdAt: new Date(),
                updatedAt: new Date(),
              },
              contextWindow: {
                selectedMessages: [],
                truncated: false,
                selectionReason: "full-history",
              },
            },
          },
          interpretation: {
            startedAt: Date.now(),
            durationMs: 1,
            result: {
              responseIntent: "assistant_identity",
            },
          },
        };
      },
      async runInterpreted() {
        throw new Error("runInterpreted should not be used for assistant identity turns");
      },
      async runWithoutRetrieval() {
        return {
          rewrittenQuery: "Remind me what you do around here",
          contexts: [],
          prompt: "",
          citations: [],
          responseIdentity: {
            name: "Vikram",
          },
          responseSettings: {
            citationDisplayEnabled: true,
            conversationMode: "guided",
            suggestedQuestionsEnabled: true,
            suggestedQuestionsCount: 3,
            customInstruction: "Keep the reply brief.",
            responseLanguagePolicy: "match_user_question",
          },
          diagnostics: {
            rewriteStatus: "applied",
            rerankStatus: "skipped",
            originalCandidateCount: 0,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 0,
            normalizedCandidateCount: 0,
            finalContextCount: 0,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            responseIntent: "assistant_identity",
            retrievalSkipped: true,
            intentConfidence: 0.9,
            intentFallbackApplied: false,
            parsedQuery: {
              originalQuery: "Remind me what you do around here",
              semanticQuery: "Remind me what you do around here",
              lexicalQuery: "Remind me what you do around here",
              constraints: [],
            },
            triggerAnalysis: {
              status: "skipped_non_retrieval",
              consideredRules: [],
              matchedRuleIds: [],
              unmatchedRuleIds: [],
              matchCount: 0,
              matcherVersion: "non_retrieval",
            },
          },
          trace: {
            traceId: "trace-2",
            startedAt: new Date().toISOString(),
            stages: [
              { stageId: "diagnostics", kind: "diagnostics", label: "Diagnostics", status: "skipped" },
            ],
            links: [],
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer({ prompt }) {
        observedPrompt = prompt;
        return "I'm Vikram.";
      },
      async *streamAnswer() {
        yield "unused";
      },
    };
    const service = new ChatService(
      conversationRepository,
      messageRepository,
      asChatRetrievalPipeline(retrievalPipeline) as never,
      chatGateway,
      auditService,
      groundedMissResponseComposer,
    );

    const response = await service.answer({
      workspaceId: "workspace-1",
      query: "Remind me what you do around here",
      stream: false,
    });

    expect(response.answer).toBe("I'm Vikram.");
    expect(response.route).toEqual({
      type: "direct",
      reason: "assistant_identity",
    });
    expect(response.retrievalInfo).toMatchObject({
      responseIntent: "assistant_identity",
      retrievalSkipped: true,
    });
    expect(observedPrompt).toContain("Answer Instructions:");
    expect(observedPrompt).toContain("Vikram");
    expect(observedPrompt).toContain("Keep the reply brief.");
  });

  it("adds explicit missing-identity guidance when assistant identity is not configured", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    let observedPrompt = "";
    const retrievalPipeline = createIntentRoutedNoContextPipeline({
      query: "Who are you?",
      responseIntent: "assistant_identity",
    });
    const chatGateway: ChatGateway = {
      async answer({ prompt }) {
        observedPrompt = prompt;
        return "I don't have a configured workspace identity yet.";
      },
      async *streamAnswer() {
        yield "unused";
      },
    };
    const service = new ChatService(
      conversationRepository,
      messageRepository,
      asChatRetrievalPipeline(retrievalPipeline) as never,
      chatGateway,
      auditService,
      groundedMissResponseComposer,
    );

    await service.answer({
      workspaceId: "workspace-1",
      query: "Who are you?",
      stream: false,
    });

    expect(observedPrompt).toContain("Identity status: not_configured");
    expect(observedPrompt).toContain("Say that you are the assistant that can answer the user's questions.");
  });

});
