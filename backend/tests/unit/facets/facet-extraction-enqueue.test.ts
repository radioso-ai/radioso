import { describe, expect, it, vi } from "vitest";

import { ChatSessionPreparer, isEligibleForFacetExtraction } from "../../../src/modules/chat/services/chatSessionPreparer.js";
import type { RetrievalTurnPort } from "../../../src/modules/chat/services/retrievalTurnDispatch.js";
import type { RetrievalPipelineRequest, RetrievalPipelineResult } from "../../../src/modules/retrieval/public.js";
import type { FacetExtractionJobStore } from "../../../src/modules/facets/contracts.js";
import { OPERATOR_TEST_SOURCE_CHANNELS } from "../../../src/shared/domain/conversationSource.js";
import {
  createAuditService,
  InMemoryAgentRepository,
  InMemoryConversationRepository,
  InMemoryMessageRepository,
} from "../../support/fakes.js";

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

const preparerWith = async (facetExtractionJobs?: Pick<FacetExtractionJobStore, "enqueue">) => {
  const conversationRepository = new InMemoryConversationRepository();
  const messageRepository = new InMemoryMessageRepository();
  const agentRepository = new InMemoryAgentRepository();
  const agent = await agentRepository.create("ws-1", { name: "Bot" });
  return {
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
      undefined,
      { warn: vi.fn() },
      facetExtractionJobs,
    ),
  };
};

describe("isEligibleForFacetExtraction", () => {
  it("admits a customer visitor question on an end-user channel", () => {
    expect(isEligibleForFacetExtraction({ role: "user", source: "customer", sourceChannel: null })).toBe(true);
    expect(isEligibleForFacetExtraction({ role: "user", source: null, sourceChannel: "widget" })).toBe(true);
  });

  it("excludes non-user roles", () => {
    expect(isEligibleForFacetExtraction({ role: "assistant", source: "customer", sourceChannel: null })).toBe(false);
    expect(isEligibleForFacetExtraction({ role: "system", source: "customer", sourceChannel: null })).toBe(false);
  });

  it("excludes non-customer sources", () => {
    expect(isEligibleForFacetExtraction({ role: "user", source: "human_agent", sourceChannel: null })).toBe(false);
    expect(isEligibleForFacetExtraction({ role: "user", source: "ai_agent", sourceChannel: null })).toBe(false);
  });

  it("excludes operator test source channels", () => {
    for (const channel of OPERATOR_TEST_SOURCE_CHANNELS) {
      expect(isEligibleForFacetExtraction({ role: "user", source: "customer", sourceChannel: channel })).toBe(false);
    }
  });
});

describe("ChatSessionPreparer facet extraction enqueue", () => {
  it("enqueues extraction for an eligible visitor message", async () => {
    const enqueue = vi.fn(async () => ({ id: "job-1", created: true }));
    const { preparer, agent } = await preparerWith({ enqueue });

    const session = await preparer.prepare({
      workspaceId: "ws-1",
      agentId: agent.id,
      query: "How much does the retreat cost?",
    });

    expect(enqueue).toHaveBeenCalledWith({ messageId: session.userMessage.id, workspaceId: "ws-1" });
  });

  it("does not enqueue extraction for an operator test channel", async () => {
    const enqueue = vi.fn(async () => ({ id: "job-1", created: true }));
    const { preparer, agent } = await preparerWith({ enqueue });

    await preparer.prepare({
      workspaceId: "ws-1",
      agentId: agent.id,
      query: "How much does the retreat cost?",
      sourceChannel: "authenticated_chat",
    });

    expect(enqueue).not.toHaveBeenCalled();
  });

  it("never fails the message write when enqueue rejects", async () => {
    const enqueue = vi.fn(async () => {
      throw new Error("queue unavailable");
    });
    const { preparer, agent } = await preparerWith({ enqueue });

    const session = await preparer.prepare({
      workspaceId: "ws-1",
      agentId: agent.id,
      query: "How much does the retreat cost?",
    });

    expect(session.userMessage.content).toBe("How much does the retreat cost?");
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("does nothing when no facet extraction port is wired", async () => {
    const { preparer, agent } = await preparerWith(undefined);

    await expect(
      preparer.prepare({ workspaceId: "ws-1", agentId: agent.id, query: "Hi" }),
    ).resolves.toBeDefined();
  });
});
