import { describe, expect, it } from "vitest";

import { ChatSessionPreparer } from "../../src/modules/chat/services/chatSessionPreparer.js";
import type { RetrievalTurnPort } from "../../src/modules/chat/services/retrievalTurnDispatch.js";
import type { RetrievalPipelineRequest, RetrievalPipelineResult } from "../../src/modules/retrieval/public.js";
import {
  createAuditService,
  InMemoryAgentRepository,
  InMemoryBootstrapGreetingCacheRepository,
  InMemoryConversationRepository,
  InMemoryMessageRepository,
  publishedRevisionResolverFor,
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

describe("ChatSessionPreparer bootstrap greeting promotion", () => {
  it("copies an exact greeting's chips from the delivery record into the promoted message metadata", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const bootstrapGreetingCacheRepository = new InMemoryBootstrapGreetingCacheRepository();
    const agentRepository = new InMemoryAgentRepository();
    const agent = await agentRepository.create("ws-1", { name: "Support Bot", proactiveGreetingEnabled: true });
    const suggestions = [{ id: "book", text: "Book now", kind: "authored", action: { kind: "ask_followup" } }];
    const greeting = await bootstrapGreetingCacheRepository.save({
      workspaceId: "ws-1",
      agentId: agent.id,
      fingerprint: "exact-fp-1",
      localeUsed: "en",
      greetingText: "Hi there.",
      suggestions,
    });
    const preparer = new ChatSessionPreparer(
      conversationRepository,
      messageRepository,
      retrievalTurnStub,
      createAuditService(),
      undefined,
      { async resolve() { return agent; } },
      bootstrapGreetingCacheRepository,
      undefined, undefined, undefined, undefined, undefined,
      publishedRevisionResolverFor(agent),
    );

    const session = await preparer.prepare({
      workspaceId: "ws-1",
      agentId: agent.id,
      query: "Hello",
      bootstrapGreetingId: greeting.id,
    });

    const promoted = session.history.find((message) => message.content === "Hi there.");
    expect(promoted).toBeDefined();
    expect(promoted?.metadata).toMatchObject({ bootstrapGreeting: true, suggestions });
  });

  it("leaves message metadata without a suggestions key for an automatic greeting (no delivery-record chips)", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const bootstrapGreetingCacheRepository = new InMemoryBootstrapGreetingCacheRepository();
    const agentRepository = new InMemoryAgentRepository();
    const agent = await agentRepository.create("ws-1", { name: "Support Bot", proactiveGreetingEnabled: true });
    const greeting = await bootstrapGreetingCacheRepository.save({
      workspaceId: "ws-1",
      agentId: agent.id,
      fingerprint: "automatic-fp-1",
      localeUsed: "en",
      greetingText: "Hello! How can I help?",
    });
    const preparer = new ChatSessionPreparer(
      conversationRepository,
      messageRepository,
      retrievalTurnStub,
      createAuditService(),
      undefined,
      { async resolve() { return agent; } },
      bootstrapGreetingCacheRepository,
      undefined, undefined, undefined, undefined, undefined,
      publishedRevisionResolverFor(agent),
    );

    const session = await preparer.prepare({
      workspaceId: "ws-1",
      agentId: agent.id,
      query: "Hello",
      bootstrapGreetingId: greeting.id,
    });

    const promoted = session.history.find((message) => message.content === "Hello! How can I help?");
    expect(promoted).toBeDefined();
    expect(promoted?.metadata).toMatchObject({ bootstrapGreeting: true });
    expect(promoted?.metadata).not.toHaveProperty("suggestions");
  });
});
