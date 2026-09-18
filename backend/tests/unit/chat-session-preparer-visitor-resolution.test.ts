import { describe, expect, it, vi } from "vitest";
import type { ConversationRequestContext } from "@radioso/conversation-contract";

import { ChatSessionPreparer } from "../../src/modules/chat/services/chatSessionPreparer.js";
import type { VisitorResolverPort } from "../../src/modules/visitors/public.js";
import type { RetrievalTurnPort } from "../../src/modules/chat/services/retrievalTurnDispatch.js";
import type { RetrievalPipelineRequest, RetrievalPipelineResult } from "../../src/modules/retrieval/public.js";
import {
  createAuditService,
  InMemoryAgentRepository,
  InMemoryConversationRepository,
  InMemoryMessageRepository,
  publishedRevisionIdFor,
  publishedRevisionResolverFixture,
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
      parsedQuery: { semanticQuery: request.query, lexicalQuery: request.query, constraints: [] },
    },
    trace: { traceId: "trace-1", startedAt: now, completedAt: now, totalDurationMs: 0, stages: [], links: [] },
  };
};

const retrievalTurnStub: RetrievalTurnPort = {
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

const buildVisitorResolverFake = (visitorId: string): VisitorResolverPort => ({
  resolveForConversation: vi.fn().mockResolvedValue({ visitorId }),
  attachVerifiedIdentity: vi.fn().mockResolvedValue({ outcome: "upgraded" }),
});

const buildPreparer = (
  conversationRepository: InMemoryConversationRepository,
  messageRepository: InMemoryMessageRepository,
  agent: { id: string; resolve?: never },
  visitorResolver?: VisitorResolverPort,
) =>
  new ChatSessionPreparer(
    conversationRepository,
    messageRepository,
    retrievalTurnStub,
    createAuditService(),
    undefined,
    { async resolve() { return agent as never; } },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    publishedRevisionResolverFixture(),
    visitorResolver,
  );

describe("ChatSessionPreparer visitor resolution (spec 1277)", () => {
  it("resolves a visitor for a brand-new production conversation and persists visitorId", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const agentRepository = new InMemoryAgentRepository();
    const agent = await agentRepository.create("ws-1", { name: "Bot" });
    const visitorResolver = buildVisitorResolverFake("visitor-123");
    const preparer = buildPreparer(conversationRepository, messageRepository, agent, visitorResolver);

    const session = await preparer.prepare({
      workspaceId: "ws-1",
      agentId: agent.id,
      query: "Hi",
      chatSessionId: "anon-session-1",
    });

    expect(visitorResolver.resolveForConversation).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      visitorKey: "anon-session-1",
      verifiedCustomerId: null,
      observed: { country: null, language: null, userAgent: null },
    });
    expect(session.conversation.visitorId).toBe("visitor-123");
  });

  it("prefers an explicit visitorKey over the session's chatSessionId (spec 1277 decision 6)", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const agentRepository = new InMemoryAgentRepository();
    const agent = await agentRepository.create("ws-1", { name: "Bot" });
    const visitorResolver = buildVisitorResolverFake("visitor-789");
    const preparer = buildPreparer(conversationRepository, messageRepository, agent, visitorResolver);

    await preparer.prepare({
      workspaceId: "ws-1",
      agentId: agent.id,
      query: "Hi",
      chatSessionId: "anon-session-6",
      visitorKey: "client-visitor-key-6",
    });

    expect(visitorResolver.resolveForConversation).toHaveBeenCalledWith(
      expect.objectContaining({ visitorKey: "client-visitor-key-6" }),
    );
  });

  it("derives observed facts from requestContext and persists requestContext + entryReferrer verbatim", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const agentRepository = new InMemoryAgentRepository();
    const agent = await agentRepository.create("ws-1", { name: "Bot" });
    const visitorResolver = buildVisitorResolverFake("visitor-456");
    const preparer = buildPreparer(conversationRepository, messageRepository, agent, visitorResolver);
    const requestContext: ConversationRequestContext = {
      clientIp: "203.0.113.9",
      country: "DE",
      region: "BE",
      city: "Berlin",
      userAgent: "TestAgent/1.0",
      acceptLanguage: "de-DE,de;q=0.9",
      observedVia: "edge_proof",
    };

    const session = await preparer.prepare({
      workspaceId: "ws-1",
      agentId: agent.id,
      query: "Hi",
      chatSessionId: "anon-session-2",
      requestContext,
      entryReferrer: "https://example.com/pricing",
    });

    expect(visitorResolver.resolveForConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        observed: { country: "DE", language: "de-DE,de;q=0.9", userAgent: "TestAgent/1.0" },
      }),
    );
    expect(session.conversation.requestContext).toEqual(requestContext);
    expect(session.conversation.entryReferrer).toBe("https://example.com/pricing");
  });

  it("never touches the visitor resolver for an operator-test (trusted safe-test) conversation", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const agentRepository = new InMemoryAgentRepository();
    const agent = await agentRepository.create("ws-1", { name: "Bot" });
    const visitorResolver = buildVisitorResolverFake("visitor-should-not-be-used");
    const preparer = buildPreparer(conversationRepository, messageRepository, agent, visitorResolver);

    const session = await preparer.prepare(
      {
        workspaceId: "ws-1",
        agentId: agent.id,
        query: "Hi",
        chatSessionId: "anon-session-3",
        executionMode: "safe_test",
      },
      { trustedTestRunner: true, preResolvedAgent: agent },
    );

    expect(visitorResolver.resolveForConversation).not.toHaveBeenCalled();
    expect(session.conversation.purpose).toBe("operator_test");
    expect(session.conversation.visitorId ?? null).toBeNull();
  });

  it("skips resolution when the conversation carries neither an anonymous nor a verified key", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const agentRepository = new InMemoryAgentRepository();
    const agent = await agentRepository.create("ws-1", { name: "Bot" });
    const visitorResolver = buildVisitorResolverFake("visitor-should-not-be-used");
    const preparer = buildPreparer(conversationRepository, messageRepository, agent, visitorResolver);

    await preparer.prepare({
      workspaceId: "ws-1",
      agentId: agent.id,
      query: "Hi",
      sourceChannel: "dashboard",
    });

    expect(visitorResolver.resolveForConversation).not.toHaveBeenCalled();
  });

  it("calls attachVerifiedIdentity next to setVerifiedCustomerId on a conversation's first verified turn", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const agentRepository = new InMemoryAgentRepository();
    const agent = await agentRepository.create("ws-1", { name: "Bot" });
    const existing = await conversationRepository.create({
      workspaceId: "ws-1",
      agentId: agent.id,
      anonymousSessionId: "anon-session-4",
      agentRevisionId: publishedRevisionIdFor(agent.id),
    });
    const visitorResolver = buildVisitorResolverFake("visitor-unused");
    const preparer = buildPreparer(conversationRepository, messageRepository, agent, visitorResolver);

    await preparer.prepare({
      workspaceId: "ws-1",
      agentId: agent.id,
      conversationId: existing.id,
      chatSessionId: "anon-session-4",
      query: "I'm logged in now",
      verifiedCustomerId: "customer-1",
    });

    expect(visitorResolver.attachVerifiedIdentity).toHaveBeenCalledWith({
      conversationId: existing.id,
      workspaceId: "ws-1",
      visitorKey: "anon-session-4",
      verifiedCustomerId: "customer-1",
    });
    expect(visitorResolver.resolveForConversation).not.toHaveBeenCalled();
  });

  it("never calls attachVerifiedIdentity for an operator-test conversation's first verified turn", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const agentRepository = new InMemoryAgentRepository();
    const agent = await agentRepository.create("ws-1", { name: "Bot" });
    const existing = await conversationRepository.create({
      workspaceId: "ws-1",
      agentId: agent.id,
      anonymousSessionId: "anon-session-5",
      agentRevisionId: publishedRevisionIdFor(agent.id),
      purpose: "operator_test",
    });
    const visitorResolver = buildVisitorResolverFake("visitor-unused");
    const preparer = buildPreparer(conversationRepository, messageRepository, agent, visitorResolver);

    await preparer.prepare(
      {
        workspaceId: "ws-1",
        agentId: agent.id,
        conversationId: existing.id,
        chatSessionId: "anon-session-5",
        query: "test turn",
        verifiedCustomerId: "customer-1",
        executionMode: "safe_test",
      },
      { trustedTestRunner: true, preResolvedAgent: agent },
    );

    expect(visitorResolver.attachVerifiedIdentity).not.toHaveBeenCalled();
  });
});
