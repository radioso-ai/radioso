import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";
import type { ConversationRequestContext } from "@radioso/conversation-contract";

import { ChatSessionPreparer } from "../../src/modules/chat/services/chatSessionPreparer.js";
import { visitorMatchContext } from "../../src/modules/chat/services/visitorMatchContext.js";
import { AgentRevisionRuntimeResolver } from "../../src/modules/agents/runtime/agentRevisionRuntimeResolver.js";
import type { AgentRevision } from "../../src/modules/agents/public.js";
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

/** A revision resolver whose snapshot carries a single context-variable enablement. */
const revisionResolverWithEnablement = (
  agentId: string,
  enablement: { source: "request" | "pushed"; enabled: boolean } | null,
): AgentRevisionRuntimeResolver => {
  const revision: AgentRevision = {
    id: `revision-${agentId}`,
    snapshot: {
      customInstruction: null,
      directives: [],
      routines: [],
      contextVariableEnablements: enablement
        ? [{
            id: randomUUID(),
            agentId,
            variableId: randomUUID(),
            source: enablement.source,
            resolverSkillId: null,
            maxAgeSeconds: null,
            resolverTimeoutMs: null,
            surfacing: "always",
            enabled: enablement.enabled,
            createdAt: new Date(),
            updatedAt: new Date(),
          }]
        : [],
    },
    sourceDraftGeneration: 1,
    sourceBasePublishedRevisionId: null,
    createdAt: new Date(),
    publishedAt: new Date(),
    publishedVersion: 1,
  };
  return new AgentRevisionRuntimeResolver({
    findCurrentPublished: async () => revision,
    findRevision: async () => revision,
  });
};

const buildPreparer = (
  conversationRepository: InMemoryConversationRepository,
  messageRepository: InMemoryMessageRepository,
  agent: { id: string },
  revisionResolver: AgentRevisionRuntimeResolver,
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
    revisionResolver,
    undefined,
  );

const fakeRequestContext: ConversationRequestContext = {
  clientIp: "203.0.113.42",
  country: "DE",
  region: "BE",
  city: "Berlin",
  userAgent: "TestAgent/1.0 fingerprint",
  acceptLanguage: "de-DE,de;q=0.9",
  observedVia: "edge_proof",
};

describe("ChatSessionPreparer visitor_request wiring (spec 1277 slice 4)", () => {
  it("stages visitor_request from the conversation's requestContext when the agent has it enabled", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const agentRepository = new InMemoryAgentRepository();
    const agent = await agentRepository.create("ws-1", { name: "Bot" });
    const preparer = buildPreparer(
      conversationRepository,
      messageRepository,
      agent,
      revisionResolverWithEnablement(agent.id, { source: "request", enabled: true }),
    );

    const session = await preparer.prepare({
      workspaceId: "ws-1",
      agentId: agent.id,
      query: "Hi",
      chatSessionId: "anon-session-vr-1",
      requestContext: fakeRequestContext,
      pageContext: { pageUrl: "https://shop.example/checkout" },
      entryReferrer: "https://partner.example",
    });

    expect(session.resolvedContext.snapshot.visitor_request).toEqual({
      country: "DE",
      region: "BE",
      city: "Berlin",
      language: "de",
      referrer: "https://partner.example",
      entryPageUrl: "https://shop.example/checkout",
    });

    // Neither surface-sensitive raw field ever rides along.
    const serialized = JSON.stringify(session.resolvedContext.snapshot);
    expect(serialized).not.toContain("203.0.113.42");
    expect(serialized).not.toContain("fingerprint");

    // Both classification surfaces (matcher + fused planner) read the same projection
    // (spec FR-032): visitorMatchContext backs conversationProcessTurnInput's matcher
    // input and chatService.planVisitorContext alike.
    const matchContext = visitorMatchContext(session);
    expect(matchContext.context.visitor_request).toEqual(session.resolvedContext.snapshot.visitor_request);
  });

  it("omits visitor_request when the agent has no enabled request-sourced enablement (FR-031 AS2)", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const agentRepository = new InMemoryAgentRepository();
    const agent = await agentRepository.create("ws-1", { name: "Bot" });
    const preparer = buildPreparer(
      conversationRepository,
      messageRepository,
      agent,
      revisionResolverWithEnablement(agent.id, null),
    );

    const session = await preparer.prepare({
      workspaceId: "ws-1",
      agentId: agent.id,
      query: "Hi",
      chatSessionId: "anon-session-vr-2",
      requestContext: fakeRequestContext,
      entryReferrer: "https://partner.example",
    });

    expect(session.resolvedContext.snapshot).not.toHaveProperty("visitor_request");
    expect(visitorMatchContext(session).context).not.toHaveProperty("visitor_request");
  });

  it("omits visitor_request when the enablement row is disabled", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const agentRepository = new InMemoryAgentRepository();
    const agent = await agentRepository.create("ws-1", { name: "Bot" });
    const preparer = buildPreparer(
      conversationRepository,
      messageRepository,
      agent,
      revisionResolverWithEnablement(agent.id, { source: "request", enabled: false }),
    );

    const session = await preparer.prepare({
      workspaceId: "ws-1",
      agentId: agent.id,
      query: "Hi",
      chatSessionId: "anon-session-vr-3",
      requestContext: fakeRequestContext,
    });

    expect(session.resolvedContext.snapshot).not.toHaveProperty("visitor_request");
  });
});
