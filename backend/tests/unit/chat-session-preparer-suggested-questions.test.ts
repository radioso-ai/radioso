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
      agentInternalName: agent.internalName ?? null,
      sourceChannel: "workbench_replay",
      sourceOrigin: null,
      channelContext: null,
      anonymousSessionId: null,
      verifiedCustomerId: null,
      entryPageUrl: null,
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

  it("holds page context aside from the initial staged spine until the read gate resolves", async () => {
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

    expect(session.pageContext).toEqual({
      pageUrl: "https://example.test/docs",
      pageTitle: "Docs",
      pageLocale: "en-US",
      browserLocale: "en",
      content: "Visible page text.",
    });
    expect(session.stagedContext).toHaveLength(1);
    expect(session.stagedContext[0]?.kind).toBe("retrieval");
    expect(session.resolvedContext).toEqual({
      fragments: [],
      renderFragments: [],
      staged: [],
      snapshot: {},
    });
  });

  it("resolves host context variables from the repository into the prepared turn", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const agentRepository = new InMemoryAgentRepository();
    const agent = await agentRepository.create("ws-1", { name: "Shop Bot" });
    const retrievalTurn: RetrievalTurnPort = {
      async interpret(request: RetrievalPipelineRequest) {
        return {
          request,
          traceStartedAtMs: Date.now(),
          context: { result: {} as never, startedAt: Date.now(), durationMs: 0 },
          interpretation: { result: {}, startedAt: Date.now(), durationMs: 0 },
        };
      },
      async dispatch(input) {
        return fixedRetrievalResult(input.interpreted.request);
      },
    };
    const resolveForAgent = vi.fn(async () => [
      {
        name: "cart",
        description: "the cart",
        value: { items: 2 },
        surfacing: "always" as const,
        sensitive: false,
        trust: "unverified" as const,
      },
    ]);
    const preparer = new ChatSessionPreparer(
      conversationRepository,
      messageRepository,
      retrievalTurn,
      createAuditService(),
      undefined,
      { async resolve() { return agent; } },
      undefined,
      { resolveForAgent },
    );

    const session = await preparer.prepare({
      workspaceId: "ws-1",
      agentId: agent.id,
      query: "Can I get a discount?",
      anonymousSessionId: "sess-1",
    });

    // resolved once, with scopes most-specific first
    expect(resolveForAgent).toHaveBeenCalledTimes(1);
    expect(resolveForAgent).toHaveBeenCalledWith("ws-1", agent.id, [
      { type: "session", id: "sess-1" },
      { type: "agent", id: agent.id },
      { type: "workspace", id: "ws-1" },
    ]);
    const cartStaged = session.stagedContext.find((entry) => entry.id === "cart");
    expect(cartStaged?.kind).toBe("context_variable");
    expect(session.resolvedContext.renderFragments).toContainEqual({
      kind: "variable",
      name: "cart",
      description: "the cart",
      value: { items: 2 },
      trust: "unverified",
    });
    expect(session.resolvedContext.snapshot).toMatchObject({ cart: { items: 2 } });
  });

  it("does not enter potentially skill-backed context resolution for a probe turn", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const agentRepository = new InMemoryAgentRepository();
    const agent = await agentRepository.create("ws-1", { name: "Probe Bot" });
    const retrievalTurn: RetrievalTurnPort = {
      async interpret(request: RetrievalPipelineRequest) {
        return {
          request,
          traceStartedAtMs: Date.now(),
          context: { result: {} as never, startedAt: Date.now(), durationMs: 0 },
          interpretation: { result: {}, startedAt: Date.now(), durationMs: 0 },
        };
      },
      async dispatch(input) {
        return fixedRetrievalResult(input.interpreted.request);
      },
    };
    const resolveForAgent = vi.fn(async () => [{
      name: "unsafe",
      description: "resolver result",
      value: "must not resolve",
      surfacing: "always" as const,
      sensitive: false,
      trust: "unverified" as const,
    }]);
    const preparer = new ChatSessionPreparer(
      conversationRepository,
      messageRepository,
      retrievalTurn,
      createAuditService(),
      undefined,
      { async resolve() { return agent; } },
      undefined,
      { resolveForAgent },
    );

    const session = await preparer.prepare({
      workspaceId: "ws-1",
      agentId: agent.id,
      query: "Test safely",
      effectProfile: "probe",
    });

    expect(resolveForAgent).not.toHaveBeenCalled();
    expect(session.resolvedContext.snapshot).toEqual({});
  });

  it("adds the verified customer scope before agent scope and stages verified identity", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const agentRepository = new InMemoryAgentRepository();
    const agent = await agentRepository.create("ws-1", { name: "Shop Bot" });
    const retrievalTurn: RetrievalTurnPort = {
      async interpret(request: RetrievalPipelineRequest) {
        return {
          request,
          traceStartedAtMs: Date.now(),
          context: { result: {} as never, startedAt: Date.now(), durationMs: 0 },
          interpretation: { result: {}, startedAt: Date.now(), durationMs: 0 },
        };
      },
      async dispatch(input) {
        return fixedRetrievalResult(input.interpreted.request);
      },
    };
    const resolveForAgent = vi.fn(async () => []);
    const preparer = new ChatSessionPreparer(
      conversationRepository,
      messageRepository,
      retrievalTurn,
      createAuditService(),
      undefined,
      { async resolve() { return agent; } },
      undefined,
      { resolveForAgent },
    );

    const session = await preparer.prepare({
      workspaceId: "ws-1",
      agentId: agent.id,
      query: "What is my plan?",
      anonymousSessionId: "sess-1",
      verifiedCustomerId: "cust-1",
      verifiedIdentity: { customerId: "cust-1", plan: "pro" },
    });

    expect(resolveForAgent).toHaveBeenCalledWith("ws-1", agent.id, [
      { type: "session", id: "sess-1" },
      { type: "customer", id: "cust-1" },
      { type: "agent", id: agent.id },
      { type: "workspace", id: "ws-1" },
    ]);
    expect(session.stagedContext).toContainEqual({
      kind: "context_variable",
      id: "visitor_identity",
      data: {
        kind: "variable",
        name: "visitor_identity",
        description: "Verified visitor identity supplied by the host.",
        value: { customerId: "cust-1", plan: "pro" },
        trust: "verified",
      },
      metadata: {
        variableName: "visitor_identity",
        surfacing: "on_reference",
        trustTier: "verified",
        sensitive: true,
      },
    });
    expect(session.resolvedContext.snapshot).toMatchObject({ visitor_identity: "[redacted]" });
  });

  it("binds a verified customer id to a new conversation and resolves the customer scope", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const agentRepository = new InMemoryAgentRepository();
    const agent = await agentRepository.create("ws-1", { name: "Shop Bot" });
    const retrievalTurn: RetrievalTurnPort = {
      async interpret(request: RetrievalPipelineRequest) {
        return {
          request,
          traceStartedAtMs: Date.now(),
          context: { result: {} as never, startedAt: Date.now(), durationMs: 0 },
          interpretation: { result: {}, startedAt: Date.now(), durationMs: 0 },
        };
      },
      async dispatch(input) {
        return fixedRetrievalResult(input.interpreted.request);
      },
    };
    const resolveForAgent = vi.fn(async () => []);
    const preparer = new ChatSessionPreparer(
      conversationRepository,
      messageRepository,
      retrievalTurn,
      createAuditService(),
      undefined,
      { async resolve() { return agent; } },
      undefined,
      { resolveForAgent },
    );

    const session = await preparer.prepare({
      workspaceId: "ws-1",
      agentId: agent.id,
      query: "What is my plan?",
      anonymousSessionId: "sess-1",
      verifiedCustomerId: "cust-1",
      verifiedIdentity: { customerId: "cust-1", plan: "pro" },
    });

    expect(session.conversation.verifiedCustomerId).toBe("cust-1");
    expect(resolveForAgent).toHaveBeenCalledWith("ws-1", agent.id, [
      { type: "session", id: "sess-1" },
      { type: "customer", id: "cust-1" },
      { type: "agent", id: agent.id },
      { type: "workspace", id: "ws-1" },
    ]);
  });

  it("uses the bound verified customer id on follow-up turns without a fresh verified token", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const agentRepository = new InMemoryAgentRepository();
    const agent = await agentRepository.create("ws-1", { name: "Shop Bot" });
    const retrievalTurn: RetrievalTurnPort = {
      async interpret(request: RetrievalPipelineRequest) {
        return {
          request,
          traceStartedAtMs: Date.now(),
          context: { result: {} as never, startedAt: Date.now(), durationMs: 0 },
          interpretation: { result: {}, startedAt: Date.now(), durationMs: 0 },
        };
      },
      async dispatch(input) {
        return fixedRetrievalResult(input.interpreted.request);
      },
    };
    const resolveForAgent = vi.fn(async () => []);
    const preparer = new ChatSessionPreparer(
      conversationRepository,
      messageRepository,
      retrievalTurn,
      createAuditService(),
      undefined,
      { async resolve() { return agent; } },
      undefined,
      { resolveForAgent },
    );

    const first = await preparer.prepare({
      workspaceId: "ws-1",
      agentId: agent.id,
      query: "What is my plan?",
      anonymousSessionId: "sess-1",
      verifiedCustomerId: "cust-1",
      verifiedIdentity: { customerId: "cust-1", plan: "pro" },
    });
    resolveForAgent.mockClear();

    const followUp = await preparer.prepare({
      workspaceId: "ws-1",
      agentId: agent.id,
      conversationId: first.conversation.id,
      query: "And my order?",
      anonymousSessionId: "sess-1",
    });

    expect(followUp.conversation.verifiedCustomerId).toBe("cust-1");
    expect(resolveForAgent).toHaveBeenCalledWith("ws-1", agent.id, [
      { type: "session", id: "sess-1" },
      { type: "customer", id: "cust-1" },
      { type: "agent", id: agent.id },
      { type: "workspace", id: "ws-1" },
    ]);
    expect(followUp.stagedContext.some((entry) => entry.id === "visitor_identity")).toBe(false);
  });
});
