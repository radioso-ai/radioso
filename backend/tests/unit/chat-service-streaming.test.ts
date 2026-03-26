import { describe, expect, it } from "vitest";

import { DEFAULT_UNSUPPORTED_NOTICE } from "../../src/modules/chat/services/assistantTurnOutcomeClassifier.js";
import { ChatService, type ChatGateway, type ChatStreamEvent } from "../../src/modules/chat/services/chatService.js";
import { createAuditService, InMemoryConversationRepository, InMemoryMessageRepository } from "../support/fakes.js";

describe("chat service streaming", () => {
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
      retrievalPipeline as never,
      chatGateway,
      auditService,
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
        const persisted = await messageRepository.listByConversationId(conversationId!);
        expect(persisted.map((message) => message.role)).toEqual(["user"]);
      }
    }

    expect(events[0]).toEqual({ type: "conversation", conversationId: expect.any(String) });
    expect(events[1]).toEqual({ type: "chunk", text: "full answer" });
    expect(events[2]).toEqual({
      type: "done",
      conversationId: expect.any(String),
      answer: "full answer",
      citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Intro" }],
      answerSegments: [{ text: "full answer", citationIndices: [0] }],
      retrievalInfo: expect.objectContaining({
        parsedQuery: {
          semanticQuery: "page do",
          lexicalQuery: "page do",
          constraintSummary: [],
        },
        candidateCounts: {
          semantic: 1,
          lexical: 1,
          merged: 1,
          final: 1,
        },
        fallbackApplied: false,
        rerankStatus: "skipped",
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
    const persisted = await messageRepository.listByConversationId(conversationId!);
    expect(persisted.map((message) => ({ role: message.role, content: message.content }))).toEqual([
      { role: "user", content: "What does this page do?" },
      { role: "assistant", content: "full answer" },
    ]);
    expect(auditService.events[0]?.metadata?.carryForwardLiterals).toEqual(["Intro"]);
  });

  it("loads literal-only carry-forward from the previous successful answer", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const capturedInputs: Array<{ rewriteCarryForwardLiterals?: string[] }> = [];
    const retrievalPipeline = {
      async run(input: { query: string; rewriteCarryForwardLiterals?: string[] }) {
        capturedInputs.push({ rewriteCarryForwardLiterals: input.rewriteCarryForwardLiterals });
        return {
          rewrittenQuery: input.query,
          contexts: [
            {
              chunkId: "chunk-1",
              documentId: "doc-1",
              title: "La mia anima ricorda Swami Kriyananda",
              content: "full answer",
            },
          ],
          prompt: "prompt text",
          citations: [
            {
              documentId: "doc-1",
              chunkId: "chunk-1",
              title: "La mia anima ricorda Swami Kriyananda",
            },
          ],
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
              rewrittenQuery: "Can I buy Narayani's book?",
              turnKind: "referential_followup",
              proposedActiveSubject: "Narayani",
              relatedEntities: [],
              unresolved: false,
              confidence: 0.9,
            },
            parsedQuery: {
              semanticQuery: "page do",
              lexicalQuery: "page do",
              constraints: [],
            },
          },
          responseSettings: {
            citationDisplayEnabled: true,
            warmthLevel: 5,
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
      retrievalPipeline as never,
      chatGateway,
      auditService,
    );

    const first = await service.answer({
      workspaceId: "workspace-1",
      accountId: "account-1",
      query: "Can I buy her book?",
      stream: false,
    });

    await service.answer({
      workspaceId: "workspace-1",
      accountId: "account-1",
      conversationId: first.conversationId,
      query: "how much is it?",
      stream: false,
    });

    expect(capturedInputs[0]?.rewriteCarryForwardLiterals).toBeUndefined();
    expect(capturedInputs[1]?.rewriteCarryForwardLiterals).toEqual([
      "Narayani",
      "La mia anima ricorda Swami Kriyananda",
    ]);
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
      retrievalPipeline as never,
      chatGateway,
      auditService,
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
    expect(doneEvent).toEqual({
      type: "done",
      conversationId: expect.any(String),
      answer: DEFAULT_UNSUPPORTED_NOTICE,
      citations: [],
      answerSegments: [{ text: DEFAULT_UNSUPPORTED_NOTICE }],
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
    const persisted = await messageRepository.listByConversationId(conversationId!);
    expect(persisted.at(-1)).toMatchObject({
      role: "assistant",
      content: DEFAULT_UNSUPPORTED_NOTICE,
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
      retrievalPipeline as never,
      chatGateway,
      auditService,
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
      answer: DEFAULT_UNSUPPORTED_NOTICE,
      citations: [],
      answerSegments: [{ text: DEFAULT_UNSUPPORTED_NOTICE }],
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
    const persisted = await messageRepository.listByConversationId(conversationId!);
    expect(persisted.at(-1)).toMatchObject({
      role: "assistant",
      content: DEFAULT_UNSUPPORTED_NOTICE,
    });
  });

  it("does not persist a duplicate assistant turn when touch fails after the assistant answer is written", async () => {
    class FailingTouchConversationRepository extends InMemoryConversationRepository {
      override async touch(): Promise<void> {
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
      retrievalPipeline as never,
      chatGateway,
      auditService,
    );

    await expect(service.answer({
      workspaceId: "workspace-1",
      query: "What does this page do?",
      stream: false,
    })).rejects.toThrow("touch failed");

    const [conversationId] = conversationRepository.items.keys();
    const persisted = await messageRepository.listByConversationId(conversationId!);
    expect(persisted.map((message) => ({ role: message.role, content: message.content }))).toEqual([
      { role: "user", content: "What does this page do?" },
      { role: "assistant", content: "I could not find relevant information in your documents." },
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
      retrievalPipeline as never,
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
            warmthLevel: 5,
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
      retrievalPipeline as never,
      chatGateway,
      auditService,
    );

    const response = await service.answer({
      workspaceId: "workspace-1",
      accountId: "account-1",
      query: "What does this page do?",
      stream: false,
    });

    expect(response.answer).toBe(
      `The page explains testing and parsing content for users. ${DEFAULT_UNSUPPORTED_NOTICE}`,
    );
    expect(response.answer).not.toContain("24/7 phone support");
    expect(response.answerSegments).toEqual([
      { text: "The page explains testing and parsing content for users", citationIndices: [0] },
      { text: `. ${DEFAULT_UNSUPPORTED_NOTICE}` },
    ]);

    const [conversationId] = conversationRepository.items.keys();
    const persisted = await messageRepository.listByConversationId(conversationId!);
    expect(persisted.at(-1)?.content).toBe(response.answer);
  });

  it("streams grounded answers incrementally before returning the validated final answer", async () => {
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
            warmthLevel: 5,
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
      retrievalPipeline as never,
      chatGateway,
      auditService,
    );

    const events: ChatStreamEvent[] = [];
    for await (const event of service.streamAnswer({
      workspaceId: "workspace-1",
      accountId: "account-1",
      query: "What does this page do?",
      stream: true,
    })) {
      events.push(event);
    }

    const streamedText = events
      .filter((event): event is Extract<ChatStreamEvent, { type: "chunk" }> => event.type === "chunk")
      .map((event) => event.text)
      .join("");

    expect(streamedText).toBe(
      "The page explains testing and parsing content for users. It also offers 24/7 phone support.",
    );
    expect(events.findIndex((event) => event.type === "chunk")).toBeGreaterThanOrEqual(0);
    expect(events.findIndex((event) => event.type === "chunk")).toBeLessThan(
      events.findIndex((event) => event.type === "done"),
    );
    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        type: "done",
        answer: `The page explains testing and parsing content for users. ${DEFAULT_UNSUPPORTED_NOTICE}`,
      }),
    );
  });
});
