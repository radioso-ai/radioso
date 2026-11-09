import { describe, expect, it } from "vitest";

import { ChatSessionPreparer } from "../../src/modules/chat/services/chatSessionPreparer.js";
import type { RetrievalTurnPort } from "../../src/modules/chat/services/retrievalTurnDispatch.js";
import type { RetrievalPipelineRequest, RetrievalPipelineResult } from "../../src/modules/retrieval/public.js";
import {
  createAuditService,
  InMemoryAgentRepository,
  InMemoryConversationRepository,
  InMemoryMessageRepository,
  publishedRevisionResolverFixture,
} from "../support/fakes.js";

const retrievalResult = (request: RetrievalPipelineRequest): RetrievalPipelineResult => {
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
      suggestedQuestionsCount: 0,
      responseLanguagePolicy: "match_user_question",
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
      parsedQuery: { semanticQuery: request.query, lexicalQuery: request.query },
    },
    trace: { traceId: "trace-1", startedAt: now, completedAt: now, totalDurationMs: 0, stages: [], links: [] },
  };
};

const setup = async () => {
  const interpreted: RetrievalPipelineRequest[] = [];
  const retrievalTurn: RetrievalTurnPort = {
    async interpret(request: RetrievalPipelineRequest) {
      interpreted.push(request);
      return {
        request,
        traceStartedAtMs: Date.now(),
        context: { result: {} as never, startedAt: Date.now(), durationMs: 0 },
        interpretation: { result: {}, startedAt: Date.now(), durationMs: 0 },
      };
    },
    async dispatch(input) {
      return retrievalResult(input.interpreted.request);
    },
  };
  const agent = await new InMemoryAgentRepository().create("ws-1", { name: "Bot" });
  const preparer = new ChatSessionPreparer(
    new InMemoryConversationRepository(),
    new InMemoryMessageRepository(),
    retrievalTurn,
    createAuditService(),
    undefined,
    { async resolve() { return agent; } },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    publishedRevisionResolverFixture(),
  );
  return { preparer, agent, interpreted };
};

// A caller cannot skim a spoken list, so retrieval learns when the answer will be heard.
describe("ChatSessionPreparer spoken replies", () => {
  it("asks retrieval for a spoken answer on a voice conversation", async () => {
    const { preparer, agent, interpreted } = await setup();

    await preparer.prepare({
      workspaceId: "ws-1",
      agentId: agent.id,
      query: "Which retreats run in February?",
      chatSessionId: "voice-session",
      sourceChannel: "voice",
      channelContext: { provider: "voice", vendor: "elevenlabs", sessionKey: "call-1", transport: "phone" },
    });

    expect(interpreted.at(-1)?.spokenReply).toBe(true);
  });

  it("asks for a written answer on a web conversation", async () => {
    const { preparer, agent, interpreted } = await setup();

    await preparer.prepare({
      workspaceId: "ws-1",
      agentId: agent.id,
      query: "Which retreats run in February?",
      chatSessionId: "web-session",
    });

    expect(interpreted.at(-1)?.spokenReply).toBe(false);
  });
});
