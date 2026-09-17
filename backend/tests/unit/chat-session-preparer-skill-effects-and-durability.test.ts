import { describe, expect, it } from "vitest";

import { ChatSessionPreparer } from "../../src/modules/chat/services/chatSessionPreparer.js";
import type { RetrievalTurnPort } from "../../src/modules/chat/services/retrievalTurnDispatch.js";
import type { RetrievalPipelineRequest, RetrievalPipelineResult } from "../../src/modules/retrieval/public.js";
import {
  createAuditService,
  InMemoryAgentRepository,
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

const preparerWith = async () => {
  const conversationRepository = new InMemoryConversationRepository();
  const messageRepository = new InMemoryMessageRepository();
  const agentRepository = new InMemoryAgentRepository();
  const agent = await agentRepository.create("ws-1", { name: "Bot" });
  const preparer = new ChatSessionPreparer(
    conversationRepository,
    messageRepository,
    retrievalTurn,
    createAuditService(),
    undefined,
    { async resolve() { return agent; } },
    undefined, undefined, undefined, undefined, undefined, undefined,
    publishedRevisionResolverFor(agent),
  );
  return { preparer, agent };
};

describe("ChatSessionPreparer skill-effect resolution", () => {
  it("resolves a live turn to allowed regardless of any requested override", async () => {
    const { preparer, agent } = await preparerWith();
    const session = await preparer.prepare(
      { workspaceId: "ws-1", agentId: agent.id, query: "Hi", executionMode: "live", skillEffects: "suppressed" },
      { preResolvedAgent: agent, skipRetrieval: true },
    );
    expect(session.skillEffects).toBe("allowed");
  });

  it("defaults a safe-test turn to suppressed when no override is requested", async () => {
    const { preparer, agent } = await preparerWith();
    const session = await preparer.prepare(
      { workspaceId: "ws-1", agentId: agent.id, query: "Hi", executionMode: "safe_test" },
      { preResolvedAgent: agent, skipRetrieval: true },
    );
    expect(session.skillEffects).toBe("suppressed");
  });

  it("honors an explicit allowed override on a safe-test turn", async () => {
    const { preparer, agent } = await preparerWith();
    const session = await preparer.prepare(
      { workspaceId: "ws-1", agentId: agent.id, query: "Hi", executionMode: "safe_test", skillEffects: "allowed" },
      { preResolvedAgent: agent, skipRetrieval: true },
    );
    expect(session.skillEffects).toBe("allowed");
  });
});

describe("ChatSessionPreparer conversation-durability resolution", () => {
  it("defaults to durable when no caller states otherwise", async () => {
    const { preparer, agent } = await preparerWith();
    const session = await preparer.prepare(
      { workspaceId: "ws-1", agentId: agent.id, query: "Hi", executionMode: "live" },
      { preResolvedAgent: agent, skipRetrieval: true },
    );
    expect(session.conversationDurability).toBe("durable");
  });

  it("carries an explicit ephemeral request onto the session, as only WorkbenchReplayRunner states", async () => {
    const { preparer, agent } = await preparerWith();
    const session = await preparer.prepare(
      { workspaceId: "ws-1", agentId: agent.id, query: "Hi", executionMode: "safe_test", conversationDurability: "ephemeral" },
      { preResolvedAgent: agent, skipRetrieval: true },
    );
    expect(session.conversationDurability).toBe("ephemeral");
  });
});
