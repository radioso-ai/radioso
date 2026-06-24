import { describe, expect, it, vi } from "vitest";

import type { ConversationRecord } from "../../src/db/repositories/conversationRepository.js";
import type { MessageRecord } from "../../src/db/repositories/messageRepository.js";
import { ChatSessionPreparer } from "../../src/modules/chat/services/chatSessionPreparer.js";
import type { RetrievalTurnPort } from "../../src/modules/chat/services/retrievalTurnDispatch.js";
import type { RetrievalPipelineRequest, RetrievalPipelineResult } from "../../src/modules/retrieval/public.js";
import {
  createAuditService,
  InMemoryAgentRepository,
  InMemoryConversationRepository,
  InMemoryMessageRepository,
} from "../support/fakes.js";

const fixedRetrievalResult = (request: RetrievalPipelineRequest): RetrievalPipelineResult => {
  const now = new Date().toISOString();
  return {
    rewrittenQuery: request.query,
    contexts: [],
    systemPrompt: "",
    prompt: "",
    citations: [],
    responseIdentity: request.responseIdentity ?? null,
    responseSettings: {
      citationDisplayEnabled: true,
      suggestedQuestionsEnabled: false,
      suggestedQuestionsCount: 4,
      customInstruction: request.responseBehavior?.customInstruction,
      responseLanguagePolicy: "match_user_question",
      responseLanguage: request.responseLanguage,
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
        semanticQuery: request.query,
        lexicalQuery: request.query,
        constraints: [],
      },
    },
    trace: {
      traceId: "trace-1",
      startedAt: now,
      completedAt: now,
      totalDurationMs: 0,
      stages: [],
      links: [],
    },
  };
};

describe("ChatSessionPreparer suggested-question settings", () => {
  it("passes retrieval skill settings without legacy suggested-question responseBehavior overrides", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const agentRepository = new InMemoryAgentRepository();
    const agent = await agentRepository.create("ws-1", {
      name: "Support Bot",
      customInstruction: "Answer from docs.",
      suggestedQuestionsEnabled: true,
      citationDisplayEnabled: false,
      skillSettings: {
        "retrieval.answer": {
          suggestedQuestionsEnabled: false,
          suggestedQuestionsCount: 4,
        },
      },
    });
    let capturedRequest: RetrievalPipelineRequest | undefined;
    const retrievalTurn: RetrievalTurnPort = {
      async interpret(request: RetrievalPipelineRequest) {
        capturedRequest = request;
        return {
          request,
          traceStartedAtMs: Date.now(),
          context: { result: {} as never, startedAt: Date.now(), durationMs: 0 },
          interpretation: {
            result: {
            },
            startedAt: Date.now(),
            durationMs: 0,
          },
        };
      },
      async dispatch(input) {
        return fixedRetrievalResult(input.interpreted.request);
      },
    };
    const preparer = new ChatSessionPreparer(
      conversationRepository,
      messageRepository,
      retrievalTurn,
      createAuditService(),
      undefined,
      {
        async resolve() {
          return agent;
        },
      },
    );

    await preparer.prepare({
      workspaceId: "ws-1",
      agentId: agent.id,
      query: "How do refunds work?",
    });

    if (!capturedRequest) {
      throw new Error("expected retrieval request to be captured");
    }
    expect(capturedRequest.agentSkillSettings).toBe(agent.skillSettings);
    expect(capturedRequest.responseBehavior).toMatchObject({
      customInstruction: "Answer from docs.",
      citationDisplayEnabled: false,
    });
    expect(capturedRequest.responseBehavior).not.toHaveProperty("suggestedQuestionsEnabled");
    expect(capturedRequest.responseBehavior).not.toHaveProperty("suggestedQuestionsCount");
  });

  it("uses pre-resolved agent and history without resolving the agent or loading repository history", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const agentRepository = new InMemoryAgentRepository();
    const agent = await agentRepository.create("ws-1", {
      name: "Replay Bot",
      customInstruction: "Replay instructions.",
    });
    const history: MessageRecord[] = [{
      id: "history-1",
      conversationId: "conv-1",
      workspaceId: "ws-1",
      role: "user",
      content: "Earlier question",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    }];
    const persistedConversation: ConversationRecord = {
      id: "conv-ephemeral",
      workspaceId: "ws-1",
      agentId: agent.id,
      agentName: agent.name,
      sourceChannel: "workbench_replay",
      sourceOrigin: null,
      channelContext: null,
      anonymousSessionId: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    const createConversation = vi
      .spyOn(conversationRepository, "create")
      .mockResolvedValue(persistedConversation);
    const createMessage = vi
      .spyOn(messageRepository, "create")
      .mockImplementation(async (input) => ({
        id: "user-ephemeral",
        conversationId: input.conversationId,
        workspaceId: input.workspaceId,
        role: input.role,
        content: input.content,
        inputMetadata: input.inputMetadata,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      }));
    const listRecent = vi.spyOn(messageRepository, "listRecentByConversationId");
    const resolve = vi.fn(async () => {
      throw new Error("agent resolve should not be called");
    });
    let capturedRequest: RetrievalPipelineRequest | undefined;
    const retrievalTurn: RetrievalTurnPort = {
      async interpret(request: RetrievalPipelineRequest) {
        capturedRequest = request;
        return {
          request,
          traceStartedAtMs: Date.now(),
          context: { result: {} as never, startedAt: Date.now(), durationMs: 0 },
          interpretation: {
            result: {
            },
            startedAt: Date.now(),
            durationMs: 0,
          },
        };
      },
      async dispatch(input) {
        return fixedRetrievalResult(input.interpreted.request);
      },
    };
    const preparer = new ChatSessionPreparer(
      conversationRepository,
      messageRepository,
      retrievalTurn,
      createAuditService(),
      undefined,
      { resolve },
    );

    const session = await preparer.prepare({
      workspaceId: "ws-1",
      agentId: "ignored-agent",
      query: "Replay this",
    }, {
      preResolvedAgent: agent,
      preResolvedHistory: history,
    });

    expect(resolve).not.toHaveBeenCalled();
    expect(listRecent).not.toHaveBeenCalled();
    expect(createConversation).toHaveBeenCalledOnce();
    expect(createMessage).toHaveBeenCalledOnce();
    expect(session.agent).toBe(agent);
    expect(session.history).toBe(history);
    expect(capturedRequest?.history).toBe(history);
  });

  it("passes the chat-detected response language into retrieval preparation", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const agentRepository = new InMemoryAgentRepository();
    const agent = await agentRepository.create("ws-1", {
      name: "Support Bot",
      customInstruction: "Answer from docs.",
    });
    let capturedRequest: RetrievalPipelineRequest | undefined;
    const retrievalTurn: RetrievalTurnPort = {
      async interpret(request: RetrievalPipelineRequest) {
        capturedRequest = request;
        return {
          request,
          traceStartedAtMs: Date.now(),
          context: { result: {} as never, startedAt: Date.now(), durationMs: 0 },
          interpretation: {
            result: {},
            startedAt: Date.now(),
            durationMs: 0,
          },
        };
      },
      async dispatch(input) {
        return fixedRetrievalResult(input.interpreted.request);
      },
    };
    const preparer = new ChatSessionPreparer(
      conversationRepository,
      messageRepository,
      retrievalTurn,
      createAuditService(),
      undefined,
      {
        async resolve() {
          return agent;
        },
      },
    );
    const baseSession = await preparer.prepare({
      workspaceId: "ws-1",
      agentId: agent.id,
      query: "Hello",
    }, { skipRetrieval: true });

    const session = await preparer.prepareRetrieval({
      workspaceId: "ws-1",
      agentId: agent.id,
      conversationId: baseSession.conversation.id,
      query: "How do refunds work?",
    }, {
      ...baseSession,
      responseLanguage: "English",
    });

    expect(capturedRequest?.responseLanguage).toBe("English");
    expect(session.retrieval.responseSettings.responseLanguage).toBe("English");
  });

  it("adds page context as structured staged context alongside retrieval", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const agentRepository = new InMemoryAgentRepository();
    const agent = await agentRepository.create("ws-1", {
      name: "Support Bot",
      customInstruction: "Answer from docs.",
    });
    const retrievalTurn: RetrievalTurnPort = {
      async interpret(request: RetrievalPipelineRequest) {
        return {
          request,
          traceStartedAtMs: Date.now(),
          context: { result: {} as never, startedAt: Date.now(), durationMs: 0 },
          interpretation: {
            result: {},
            startedAt: Date.now(),
            durationMs: 0,
          },
        };
      },
      async dispatch(input) {
        return fixedRetrievalResult(input.interpreted.request);
      },
    };
    const preparer = new ChatSessionPreparer(
      conversationRepository,
      messageRepository,
      retrievalTurn,
      createAuditService(),
      undefined,
      {
        async resolve() {
          return agent;
        },
      },
    );

    const session = await preparer.prepare({
      workspaceId: "ws-1",
      agentId: agent.id,
      query: "What am I reading?",
      pageContext: {
        pageUrl: "https://example.test/docs",
        pageTitle: "Docs",
        pageLocale: "en-US",
        browserLocale: "en",
        content: "Visible page text.",
      },
    });

    expect(session.stagedContext).toHaveLength(2);
    expect(session.stagedContext[0]?.kind).toBe("retrieval");
    expect(session.stagedContext[1]).toEqual({
      kind: "context_variable",
      id: "page_context",
      data: {
        kind: "page_context",
        pageUrl: "https://example.test/docs",
        pageTitle: "Docs",
        pageLocale: "en-US",
        browserLocale: "en",
        content: "Visible page text.",
      },
      metadata: {
        variableName: "page_context",
        trustTier: "unverified",
      },
    });
  });
});
