import { describe, expect, it, vi } from "vitest";

import { ChatSessionPreparer } from "../../src/modules/chat/services/chatSessionPreparer.js";
import {
  AgentRevisionRuntimeResolver,
  type AgentRevisionRuntimeReaderPort,
} from "../../src/modules/agents/runtime/agentRevisionRuntimeResolver.js";
import type { AgentRevision } from "../../src/modules/agents/agentRevision.js";
import type {
  AgentContextVariableEnablement,
  ContextVariableScope,
  ContextVariableResolutionReaderPort,
  ResolvedVariableInput,
} from "../../src/modules/context-variables/public.js";
import { freezePageReadOutcome } from "../../src/modules/chat/services/pageRead/pageReadSessionOutcome.js";
import type { RetrievalTurnPort } from "../../src/modules/chat/services/retrievalTurnDispatch.js";
import type { RetrievalPipelineRequest, RetrievalPipelineResult } from "../../src/modules/retrieval/public.js";
import type { ConversationSummaryStore } from "../../src/modules/chat/contracts/conversationSummary.js";
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

const preparerWith = async (store?: Pick<ConversationSummaryStore, "load">) => {
  const conversationRepository = new InMemoryConversationRepository();
  const messageRepository = new InMemoryMessageRepository();
  const agentRepository = new InMemoryAgentRepository();
  const agent = await agentRepository.create("ws-1", { name: "Bot" });
  const publishedRevision: AgentRevision = {
    id: "99999999-9999-4999-8999-999999999999",
    snapshot: { customInstruction: agent.customInstruction, directives: [], routines: [], contextVariableEnablements: [] },
    sourceDraftGeneration: 1,
    sourceBasePublishedRevisionId: null,
    createdAt: new Date(),
    publishedAt: new Date(),
  };
  return {
    conversationRepository,
    messageRepository,
    agent,
    preparer: new ChatSessionPreparer(
      conversationRepository,
      messageRepository,
      retrievalTurn,
      createAuditService(),
      undefined,
      { resolve: async () => agent },
      undefined,
      undefined,
      store,
      undefined,
      undefined,
      undefined,
      new AgentRevisionRuntimeResolver({
        findCurrentPublished: async () => publishedRevision,
        findRevision: async () => publishedRevision,
      }),
    ),
  };
};

describe("ChatSessionPreparer rolling conversation summary (#866)", () => {
  it("fails closed when revision resolution is unwired, including a production caller that pre-resolves an agent", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const agentRepository = new InMemoryAgentRepository();
    const agent = await agentRepository.create("ws-1", { name: "Bot" });
    const preparer = new ChatSessionPreparer(
      conversationRepository, messageRepository, retrievalTurn, createAuditService(), undefined,
      { resolve: async () => agent },
    );

    await expect(preparer.prepare({ workspaceId: "ws-1", agentId: agent.id, query: "Hi" }))
      .rejects.toThrow("agent_revision_runtime_not_configured");
    await expect(preparer.prepare(
      { workspaceId: "ws-1", agentId: agent.id, query: "Hi" },
      { preResolvedAgent: agent },
    )).rejects.toThrow("agent_revision_runtime_not_configured");
  });

  it("accepts pre-resolved host values only from the trusted safe-test runner", async () => {
    const { preparer, agent } = await preparerWith();
    await expect(preparer.prepare(
      { workspaceId: "ws-1", agentId: agent.id, query: "Hi" },
      { preResolvedAgent: agent, preResolvedHostVariables: [{ name: "plan", value: "gold", surfacing: "always" }] },
    )).rejects.toThrow("pre_resolved_host_variables_require_trusted_runner");
  });

  it("binds a new conversation to the published revision and retains that release after republish", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const agentRepository = new InMemoryAgentRepository();
    const agent = await agentRepository.create("ws-1", { name: "Bot", customInstruction: "mutable" });
    const publishedOne: AgentRevision = {
      id: "11111111-1111-4111-8111-111111111111",
      snapshot: { customInstruction: "published one", directives: [], routines: [], contextVariableEnablements: [] },
      sourceDraftGeneration: 1,
      sourceBasePublishedRevisionId: null,
      createdAt: new Date(),
      publishedAt: new Date(),
      publishedVersion: 1,
    };
    const publishedTwo: AgentRevision = { ...publishedOne, id: "22222222-2222-4222-8222-222222222222", snapshot: { ...publishedOne.snapshot, customInstruction: "published two" } };
    let current = publishedOne;
    const reader: AgentRevisionRuntimeReaderPort = {
      findCurrentPublished: vi.fn(async () => current),
      findRevision: vi.fn(async ({ revisionId }) => revisionId === publishedOne.id ? publishedOne : null),
    };
    const preparer = new ChatSessionPreparer(
      conversationRepository,
      messageRepository,
      retrievalTurn,
      createAuditService(),
      undefined,
      { resolve: async () => agent },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      new AgentRevisionRuntimeResolver(reader),
    );

    const first = await preparer.prepare({ workspaceId: "ws-1", agentId: agent.id, query: "Hi" });
    current = publishedTwo;
    const followUp = await preparer.prepare({
      workspaceId: "ws-1",
      conversationId: first.conversation.id,
      query: "Still there?",
    });

    expect(first.conversation.agentRevisionId).toBe(publishedOne.id);
    expect(first.agent.customInstruction).toBe("published one");
    expect(followUp.conversation.agentRevisionId).toBe(publishedOne.id);
    expect(followUp.agent.customInstruction).toBe("published one");
    expect(reader.findCurrentPublished).toHaveBeenCalledTimes(1);
    expect(reader.findRevision).toHaveBeenCalledWith({ workspaceId: "ws-1", agentId: agent.id, revisionId: publishedOne.id });
  });

  it("fails a legacy conversation with no baseline binding instead of selecting the latest publication", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const agentRepository = new InMemoryAgentRepository();
    const agent = await agentRepository.create("ws-1", { name: "Bot" });
    const conversation = await conversationRepository.create("ws-1", agent.id);
    const published: AgentRevision = {
      id: "66666666-6666-4666-8666-666666666666",
      snapshot: { customInstruction: "latest", directives: [], routines: [], contextVariableEnablements: [] },
      sourceDraftGeneration: 1,
      sourceBasePublishedRevisionId: null,
      createdAt: new Date(),
      publishedAt: new Date(),
    };
    const resolver = new AgentRevisionRuntimeResolver({
      findCurrentPublished: vi.fn(async () => published),
      findRevision: vi.fn(async () => published),
    });
    const preparer = new ChatSessionPreparer(
      conversationRepository, messageRepository, retrievalTurn, createAuditService(), undefined,
      { resolve: async () => agent }, undefined, undefined, undefined, undefined,
      undefined, undefined, resolver,
    );

    await expect(preparer.prepare({
      workspaceId: "ws-1", conversationId: conversation.id, query: "Continue",
    })).rejects.toThrow("conversation_revision_unavailable");
  });

  it("rejects a public resume of an operator-test conversation even after its candidate is published", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const agentRepository = new InMemoryAgentRepository();
    const agent = await agentRepository.create("ws-1", { name: "Bot" });
    const candidateRevision: AgentRevision = {
      id: "77777777-7777-4777-8777-777777777777",
      snapshot: { customInstruction: "candidate", directives: [], routines: [], contextVariableEnablements: [] },
      sourceDraftGeneration: 1,
      sourceBasePublishedRevisionId: null,
      createdAt: new Date(),
      publishedAt: null,
    };
    const privateConversation = await conversationRepository.create(
      "ws-1", agent.id, null, null, null, null, null,
      { agentRevisionId: candidateRevision.id, purpose: "operator_test" },
    );
    const preparer = new ChatSessionPreparer(
      conversationRepository, messageRepository, retrievalTurn, createAuditService(), undefined,
      { resolve: async () => agent }, undefined, undefined, undefined, undefined,
      undefined, undefined, new AgentRevisionRuntimeResolver({
        findCurrentPublished: async () => candidateRevision,
        findRevision: async () => candidateRevision,
      }),
    );

    await expect(preparer.prepare({
      workspaceId: "ws-1", conversationId: privateConversation.id, query: "Read the private history",
    })).rejects.toThrow("Conversation not found");
    candidateRevision.publishedAt = new Date();
    await expect(preparer.prepare({
      workspaceId: "ws-1", conversationId: privateConversation.id, query: "Still read the private history",
    })).rejects.toThrow("Conversation not found");
  });

  it("resolves context from immutable revision enablements instead of current agent enablements", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const agentRepository = new InMemoryAgentRepository();
    const agent = await agentRepository.create("ws-1", { name: "Bot" });
    const enablement: AgentContextVariableEnablement = {
      id: "33333333-3333-4333-8333-333333333333",
      agentId: agent.id,
      variableId: "44444444-4444-4444-8444-444444444444",
      source: "pushed",
      resolverSkillId: null,
      maxAgeSeconds: null,
      resolverTimeoutMs: null,
      surfacing: "always",
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const published: AgentRevision = {
      id: "55555555-5555-4555-8555-555555555555",
      snapshot: { customInstruction: "", directives: [], routines: [], contextVariableEnablements: [enablement] },
      sourceDraftGeneration: 1,
      sourceBasePublishedRevisionId: null,
      createdAt: new Date(),
      publishedAt: new Date(),
    };
    const revisionResolver = new AgentRevisionRuntimeResolver({
      findCurrentPublished: async () => published,
      findRevision: async () => published,
    });
    const contextResolver: ContextVariableResolutionReaderPort & {
      resolveForEnablements: (workspaceId: string, agentId: string, enablements: readonly AgentContextVariableEnablement[], scopes: ContextVariableScope[]) => Promise<ResolvedVariableInput[]>;
    } = {
      resolveForAgent: vi.fn(async () => []),
      resolveForEnablements: vi.fn(async (): Promise<ResolvedVariableInput[]> => [{
        name: "frozen_context",
        description: null,
        value: "revision value",
        surfacing: "always" as const,
        sensitive: false,
        trust: "verified" as const,
      }]),
    };
    const preparer = new ChatSessionPreparer(
      conversationRepository, messageRepository, retrievalTurn, createAuditService(), undefined,
      { resolve: async () => agent }, undefined, contextResolver, undefined, undefined,
      undefined, undefined, revisionResolver,
    );

    const session = await preparer.prepare({ workspaceId: "ws-1", agentId: agent.id, query: "Hi" });

    expect(contextResolver.resolveForEnablements).toHaveBeenCalledWith(
      "ws-1", agent.id, [enablement], expect.any(Array),
    );
    expect(contextResolver.resolveForAgent).not.toHaveBeenCalled();
    expect(session.resolvedContext.snapshot).toMatchObject({ frozen_context: "revision value" });
  });

  it("keeps an empty pinned context-variable snapshot empty when a turn re-prepares", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const agentRepository = new InMemoryAgentRepository();
    const agent = await agentRepository.create("ws-1", { name: "Bot" });
    const published: AgentRevision = {
      id: "66666666-6666-4666-8666-666666666666",
      snapshot: { customInstruction: "", directives: [], routines: [], contextVariableEnablements: [] },
      sourceDraftGeneration: 1,
      sourceBasePublishedRevisionId: null,
      createdAt: new Date(),
      publishedAt: new Date(),
      publishedVersion: 1,
    };
    const contextResolver: ContextVariableResolutionReaderPort = {
      resolveForAgent: vi.fn(async () => []),
      resolveForEnablements: vi.fn(async () => []),
    };
    const preparer = new ChatSessionPreparer(
      conversationRepository, messageRepository, retrievalTurn, createAuditService(), undefined,
      { resolve: async () => agent }, undefined, contextResolver, undefined, undefined,
      undefined, undefined, new AgentRevisionRuntimeResolver({
        findCurrentPublished: async () => published,
        findRevision: async () => published,
      }),
    );

    const input = { workspaceId: "ws-1", agentId: agent.id, query: "Hi" };
    const session = await preparer.prepare(input);
    await preparer.prepareRetrieval(input, session);
    await preparer.prepareDirect(input, session);

    expect(contextResolver.resolveForEnablements).toHaveBeenCalledTimes(3);
    expect(contextResolver.resolveForEnablements).toHaveBeenNthCalledWith(
      2, "ws-1", agent.id, [], expect.any(Array),
    );
    expect(contextResolver.resolveForEnablements).toHaveBeenNthCalledWith(
      3, "ws-1", agent.id, [], expect.any(Array),
    );
    expect(contextResolver.resolveForAgent).not.toHaveBeenCalled();
  });

  it("persists the first entry page even when page reading is not required and preserves it later", async () => {
    const { preparer, agent, conversationRepository } = await preparerWith();
    const firstPageUrl = "https://it.ananda.eu/pricing?source=chat";

    const first = await preparer.prepare({
      workspaceId: "ws-1",
      agentId: agent.id,
      query: "What does this page cover?",
      pageContext: { pageUrl: firstPageUrl },
    });
    freezePageReadOutcome(first, {
      planner: null,
      routineCandidates: [],
      directiveCandidates: [],
      fallbackRequest: "",
    });
    const followUp = await preparer.prepare({
      workspaceId: "ws-1",
      agentId: agent.id,
      conversationId: first.conversation.id,
      query: "What about the next page?",
      pageContext: { pageUrl: "https://it.ananda.eu/contact" },
    });

    expect(first.pageReadOutcome?.gate).toEqual({ kind: "not_required" });
    expect(conversationRepository.items.get(first.conversation.id)?.entryPageUrl).toBe(firstPageUrl);
    expect(followUp.conversation.entryPageUrl).toBe(firstPageUrl);
  });

  it("loads the stored summary onto the prepared session for an existing conversation", async () => {
    const load = vi.fn(async () => ({
      summary: "The user booked the June retreat and paid the deposit.",
      coveredMessageCount: 12,
      coveredThrough: new Date("2026-01-02T00:00:00.000Z"),
    }));
    const { preparer, agent } = await preparerWith({ load });

    const first = await preparer.prepare({ workspaceId: "ws-1", agentId: agent.id, query: "Hi" });
    const followUp = await preparer.prepare({
      workspaceId: "ws-1",
      agentId: agent.id,
      conversationId: first.conversation.id,
      query: "And the schedule?",
    });

    expect(load).toHaveBeenLastCalledWith({ sessionId: first.conversation.id });
    expect(followUp.conversationSummary).toBe("The user booked the June retreat and paid the deposit.");
  });

  it("leaves the summary absent when no store is wired", async () => {
    const { preparer, agent } = await preparerWith();

    const first = await preparer.prepare({ workspaceId: "ws-1", agentId: agent.id, query: "Hi" });
    const followUp = await preparer.prepare({
      workspaceId: "ws-1",
      agentId: agent.id,
      conversationId: first.conversation.id,
      query: "And the schedule?",
    });

    expect(followUp.conversationSummary).toBeUndefined();
  });

  it("prefers a pre-resolved summary over the store (replay/eval parity)", async () => {
    const load = vi.fn(async () => ({
      summary: "stored summary that must be ignored",
      coveredMessageCount: 5,
      coveredThrough: new Date("2026-01-02T00:00:00.000Z"),
    }));
    const { preparer, agent } = await preparerWith({ load });

    const first = await preparer.prepare({ workspaceId: "ws-1", agentId: agent.id, query: "Hi" });
    const followUp = await preparer.prepare(
      {
        workspaceId: "ws-1",
        agentId: agent.id,
        conversationId: first.conversation.id,
        query: "And the schedule?",
      },
      { preResolvedConversationSummary: "frozen capture-time summary" },
    );

    expect(followUp.conversationSummary).toBe("frozen capture-time summary");
    // The store is never consulted when the summary is pre-resolved.
    expect(load).not.toHaveBeenCalled();
  });

  it("falls back to the store when no pre-resolved summary is supplied", async () => {
    const load = vi.fn(async () => ({
      summary: "stored summary",
      coveredMessageCount: 3,
      coveredThrough: new Date("2026-01-02T00:00:00.000Z"),
    }));
    const { preparer, agent } = await preparerWith({ load });

    const first = await preparer.prepare({ workspaceId: "ws-1", agentId: agent.id, query: "Hi" });
    const followUp = await preparer.prepare(
      {
        workspaceId: "ws-1",
        agentId: agent.id,
        conversationId: first.conversation.id,
        query: "And the schedule?",
      },
      {},
    );

    expect(load).toHaveBeenCalledWith({ sessionId: first.conversation.id });
    expect(followUp.conversationSummary).toBe("stored summary");
  });

  it("leaves the summary absent when the store has no row", async () => {
    const { preparer, agent } = await preparerWith({ load: async () => null });

    const first = await preparer.prepare({ workspaceId: "ws-1", agentId: agent.id, query: "Hi" });
    const followUp = await preparer.prepare({
      workspaceId: "ws-1",
      agentId: agent.id,
      conversationId: first.conversation.id,
      query: "And the schedule?",
    });

    expect(followUp.conversationSummary).toBeUndefined();
  });
});
