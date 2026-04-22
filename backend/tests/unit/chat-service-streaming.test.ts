import { describe, expect, it } from "vitest";

import { ChatService, type ChatGateway, type ChatStreamEvent } from "../../src/modules/chat/services/chatService.js";
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
          responseSettings: {
            citationDisplayEnabled: true,
            answerSupportPolicy: "strict",
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
      retrievalPipeline as never,
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
      answer: "full answer",
      citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Intro" }],
      answerSegments: [{ text: "full answer", citationIndices: [0] }],
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
    expect(auditService.events[0]?.metadata?.rewriteContinuityState).toEqual({
      activeSubject: undefined,
      relatedEntities: [],
      groundedTitles: ["Intro"],
    });
  });

  it("loads rewrite continuity state from the previous successful answer", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const capturedInputs: Array<{ rewriteContinuityState?: { activeSubject?: string; relatedEntities: string[]; groundedTitles: string[] } }> = [];
    const retrievalPipeline = {
      async run(input: { query: string; rewriteContinuityState?: { activeSubject?: string; relatedEntities: string[]; groundedTitles: string[] } }) {
        capturedInputs.push({ rewriteContinuityState: input.rewriteContinuityState });
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
            answerSupportPolicy: "strict",
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
      groundedMissResponseComposer,
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

    expect(capturedInputs[0]?.rewriteContinuityState).toBeUndefined();
    expect(capturedInputs[1]?.rewriteContinuityState).toEqual({
      activeSubject: "Narayani",
      relatedEntities: [],
      groundedTitles: ["La mia anima ricorda Swami Kriyananda"],
    });
  });

  it("normalizes malformed rewrite continuity state loaded from audit metadata", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditEventRepository = new InMemoryAuditEventRepository();
    const auditService = createAuditService(auditEventRepository);
    const capturedInputs: Array<{ rewriteContinuityState?: { activeSubject?: string; relatedEntities: string[]; groundedTitles: string[] } }> = [];
    const retrievalPipeline = {
      async run(input: { query: string; rewriteContinuityState?: { activeSubject?: string; relatedEntities: string[]; groundedTitles: string[] } }) {
        capturedInputs.push({ rewriteContinuityState: input.rewriteContinuityState });
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
            answerSupportPolicy: "strict",
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
      groundedMissResponseComposer,
    );

    const first = await service.answer({
      workspaceId: "workspace-1",
      accountId: "account-1",
      query: "Can I buy her book?",
      stream: false,
    });

    auditEventRepository.items[0]!.metadata.rewriteContinuityState = {
      activeSubject: 42,
      relatedEntities: ["Narayani", 7, ""],
      groundedTitles: ["La mia anima ricorda Swami Kriyananda", null],
    };

    await service.answer({
      workspaceId: "workspace-1",
      accountId: "account-1",
      conversationId: first.conversationId,
      query: "how much is it?",
      stream: false,
    });

    expect(capturedInputs[1]?.rewriteContinuityState).toEqual({
      activeSubject: undefined,
      relatedEntities: ["Narayani"],
      groundedTitles: ["La mia anima ricorda Swami Kriyananda"],
    });
  });

  it("answers assistant identity questions without retrieved document context", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run() {
        return {
          rewrittenQuery: "what is your name",
          contexts: [],
          prompt: "unused retrieval prompt",
          citations: [],
          assistantIdentity: {
            assistantName: "Marta",
            assistantRole: "Museum guide",
            greetingInstruction: "Warm and concise",
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
              semanticQuery: "what is your name",
              lexicalQuery: "what is your name",
              constraints: [],
            },
          },
          responseSettings: {
            citationDisplayEnabled: true,
            answerSupportPolicy: "strict",
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer(input) {
        expect(input.prompt).toContain("Assistant name: Marta");
        expect(input.prompt).toContain("Assistant role: Museum guide");
        return "My name is Marta. I am your museum guide.";
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
      groundedMissResponseComposer,
    );

    const response = await service.answer({
      workspaceId: "workspace-1",
      query: "What is your name and what do you do?",
      stream: false,
    });

    expect(response.answer).toBe("My name is Marta. I am your museum guide.");
    expect(response.citations).toBeUndefined();
    expect(response.answerSegments).toBeUndefined();
  });

  it("streams assistant identity answers for no-context follow-ups", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run() {
        return {
          rewrittenQuery: "what do you do",
          contexts: [],
          prompt: "unused retrieval prompt",
          citations: [],
          assistantIdentity: {
            assistantName: "Marta",
            assistantRole: "Museum guide",
            greetingInstruction: "Warm and concise",
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
              semanticQuery: "what do you do",
              lexicalQuery: "what do you do",
              constraints: [],
            },
          },
          responseSettings: {
            citationDisplayEnabled: true,
            answerSupportPolicy: "strict",
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer(input) {
        expect(input.prompt).toContain("Assistant role: Museum guide");
        return "I am Marta, and I help visitors navigate the museum.";
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
    expect(events[1]).toEqual({ type: "chunk", text: "I am Marta, and I help visitors navigate the museum." });
    expect(events[2]).toEqual(
      expect.objectContaining({
        type: "done",
        answer: "I am Marta, and I help visitors navigate the museum.",
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
          assistantIdentity: {
            assistantName: "Marta",
            assistantRole: "Museum guide",
            greetingInstruction: "Warm and concise",
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
            answerSupportPolicy: "strict",
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
      retrievalPipeline as never,
      chatGateway,
      auditService,
      groundedMissResponseComposer,
    );

    const response = await service.answer({
      workspaceId: "workspace-1",
      query: "What can you do with these documents?",
      stream: false,
    });

    expect(response.answer).toBe("I couldn't find supporting material for that in your workspace documents. If you'd like, try asking about a topic that's covered there.");
    expect(response.citations).toBeUndefined();
  });

  it("excludes URL-shaped citation titles from carry-forward literals", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const capturedInputs: Array<{ rewriteContinuityState?: { activeSubject?: string; relatedEntities: string[]; groundedTitles: string[] } }> = [];
    const retrievalPipeline = {
      async run(input: { query: string; rewriteContinuityState?: { activeSubject?: string; relatedEntities: string[]; groundedTitles: string[] } }) {
        capturedInputs.push({ rewriteContinuityState: input.rewriteContinuityState });
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
            answerSupportPolicy: "strict",
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
    expect(capturedInputs[1]?.rewriteContinuityState).toEqual({
      activeSubject: "kaibemaksumaar Eestis",
      relatedEntities: [],
      groundedTitles: [],
    });
  });

  it("persists related entities in rewrite continuity state", async () => {
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
            answerSupportPolicy: "strict",
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
      relatedEntities: ["Arudra"],
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
      retrievalPipeline as never,
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

    expect(chunkTexts.join("")).toBe(
      `I couldn't verify that from your workspace documents, but I did find related material in "Intro" if you'd like to explore that instead.`,
    );
    expect(doneEvent).toEqual({
      type: "done",
      conversationId: expect.any(String),
      answer: `I couldn't verify that from your workspace documents, but I did find related material in "Intro" if you'd like to explore that instead.`,
      citations: [],
      answerSegments: [
        { text: `I couldn't verify that from your workspace documents, but I did find related material in "Intro" if you'd like to explore that instead.` },
      ],
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

    expect(chunkTexts).toEqual([
      `I couldn't verify that from your workspace documents, but I did find related material in "Intro" if you'd like to explore that instead.`,
    ]);
    expect(doneEvent).toEqual({
      type: "done",
      conversationId: expect.any(String),
      answer: `I couldn't verify that from your workspace documents, but I did find related material in "Intro" if you'd like to explore that instead.`,
      citations: [],
      answerSegments: [
        { text: `I couldn't verify that from your workspace documents, but I did find related material in "Intro" if you'd like to explore that instead.` },
      ],
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
      retrievalPipeline as never,
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
        content: "I couldn't find supporting material for that in your workspace documents. If you'd like, try asking about a topic that's covered there.",
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
            answerSupportPolicy: "strict",
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

    expect(response.answer).toBe("The page explains testing and parsing content for users.");
    expect(response.answer).not.toContain("24/7 phone support");
    expect(response.answerSegments).toEqual([
      { text: "The page explains testing and parsing content for users", citationIndices: [0] },
      { text: "." },
    ]);

    const [conversationId] = conversationRepository.items.keys();
    const persisted = await messageRepository.listByConversationId("workspace-1", conversationId!);
    expect(persisted.at(-1)?.content).toBe(response.answer);
  });

  it("buffers strict-mode chunks until the validated final answer is available", async () => {
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
            answerSupportPolicy: "strict",
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

    expect(streamedText).toBe("The page explains testing and parsing content for users.");
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
            answerSupportPolicy: "warn",
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
      retrievalPipeline as never,
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
        answer: "Narayani is a teacher and author.",
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
            answerSupportPolicy: "warn",
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
      retrievalPipeline as never,
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
            answerSupportPolicy: "strict",
            conversationMode: "exploratory",
          },
        };
      },
    } as const;
    let suggestionPrompt: string | undefined;
    const chatGateway: ChatGateway = {
      async answer({ prompt }) {
        if (prompt.includes("Generate grounded follow-up suggestions")) {
          suggestionPrompt = prompt;
          return JSON.stringify({
            suggestions: [
              { text: "What does the interview say about Mahiya's spiritual path?", contextIndex: 1 },
              { text: "Which books or projects is Mahiya associated with?", contextIndex: 2 },
              { text: "What challenges does Mahiya describe in the other interview?", contextIndex: 3 },
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
      retrievalPipeline as never,
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

    expect(response.answer).toContain("Mahiya is a teacher and author.");
    expect(response.answer).not.toContain("\n- ");
    expect(suggestionPrompt).toContain("Prefer explicit nouns over pronouns.");
    expect(suggestionPrompt).toContain('prefer "What books did Narayani write?" over "What books did she write?"');
    expect(response.suggestions).toEqual([
      {
        text: "What does the interview say about Mahiya's spiritual path?",
        citation: {
          documentId: "doc-1",
          chunkId: "chunk-1",
          title: "Mahiya",
        },
      },
      {
        text: "Which books or projects is Mahiya associated with?",
        citation: {
          documentId: "doc-2",
          chunkId: "chunk-2",
          title: "God is our True Home: In Conversation with Mahiya - Ananda Europe",
        },
      },
      {
        text: "What challenges does Mahiya describe in the other interview?",
        citation: {
          documentId: "doc-3",
          chunkId: "chunk-3",
          title: "Il gusto della gioia - Ananda Edizioni - ricette, consigli e ispirazioni salutari",
        },
      },
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
            answerSupportPolicy: "strict",
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
              { text: "Quale altro libro o progetto è collegato a Narayani?", contextIndex: 1 },
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
      retrievalPipeline as never,
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

    expect(response.answer).toBe("Narayani ha scritto La mia anima ricorda Swami Kriyananda.");
    expect(response.suggestions).toEqual([
      {
        text: "Quale altro libro o progetto è collegato a Narayani?",
        citation: {
          documentId: "doc-1",
          chunkId: "chunk-1",
          title: "Narayani Anaya Archivi - Ananda Edizioni",
        },
      },
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
            answerSupportPolicy: "strict",
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
              { text: "What videos are on page 3?", contextIndex: 2 },
              { text: "How many Assisi archive pages are there?", contextIndex: 2 },
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
      retrievalPipeline as never,
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
      {
        text: "How many Assisi archive pages are there?",
        citation: {
          documentId: "doc-2",
          chunkId: "chunk-2",
          title: "Assisi Archives - Page 3 of 14 - Ananda Europe",
        },
      },
    ]);
  });

});
