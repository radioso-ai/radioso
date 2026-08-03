import { describe, expect, it, vi } from "vitest";

import { ChatSessionPreparer } from "../../src/modules/chat/services/chatSessionPreparer.js";
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
    ),
  };
};

describe("ChatSessionPreparer rolling conversation summary (#866)", () => {
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
