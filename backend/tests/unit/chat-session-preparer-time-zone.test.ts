import { describe, expect, it, vi } from "vitest";

import { ChatSessionPreparer } from "../../src/modules/chat/services/chatSessionPreparer.js";
import type { RetrievalTurnPort } from "../../src/modules/chat/services/retrievalTurnDispatch.js";
import { recordedVisitorTimeZone } from "../../src/modules/chat/services/turnReferenceTimeZone.js";
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

const setup = async (workspaceTimeZone: string | null) => {
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
  const readWorkspaceTimeZone = vi.fn(async () => workspaceTimeZone);
  const agent = await new InMemoryAgentRepository().create("ws-1", { name: "Bot" });
  const messages = new InMemoryMessageRepository();
  const preparer = new ChatSessionPreparer(
    new InMemoryConversationRepository(),
    messages,
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
    undefined,
    undefined,
    undefined,
    { readWorkspaceTimeZone },
  );
  const prepare = (visitorTimeZone?: string | null) => preparer.prepare({
    workspaceId: "ws-1",
    agentId: agent.id,
    query: "What's on tomorrow?",
    chatSessionId: "anon-session-tz",
    ...(visitorTimeZone === undefined ? {} : { visitorTimeZone }),
  });
  return { prepare, interpreted, readWorkspaceTimeZone, messages };
};

describe("ChatSessionPreparer reference time zone", () => {
  it("reads today in the visitor's zone and hands that zone to retrieval", async () => {
    const { prepare, interpreted, readWorkspaceTimeZone } = await setup("Europe/Rome");

    const session = await prepare("America/Los_Angeles");

    expect(session.referenceTimeZone).toEqual({ timeZone: "America/Los_Angeles", source: "visitor" });
    expect(interpreted.at(-1)?.referenceTimeZone).toEqual({ timeZone: "America/Los_Angeles", source: "visitor" });
    // A valid visitor zone decides on its own, so the turn does not read the workspace's.
    expect(readWorkspaceTimeZone).not.toHaveBeenCalled();
  });

  it("uses the workspace's zone when the visitor's client reports none", async () => {
    const { prepare, interpreted } = await setup("Europe/Rome");

    const session = await prepare();

    expect(session.referenceTimeZone).toEqual({ timeZone: "Europe/Rome", source: "workspace" });
    expect(interpreted.at(-1)?.referenceTimeZone).toEqual({ timeZone: "Europe/Rome", source: "workspace" });
  });

  it("ignores an invalid visitor zone and reads today in UTC when the workspace sets none", async () => {
    const { prepare } = await setup(null);

    const session = await prepare("Not/AZone");

    expect(session.referenceTimeZone).toEqual({ timeZone: "UTC", source: "default" });
  });

  it("records the visitor's zone on their message, so a later resume reads the zone the conversation ran in", async () => {
    const { prepare, messages } = await setup("Europe/Rome");

    const session = await prepare("America/Los_Angeles");

    const [stored] = await messages.listRecentByConversationId("ws-1", session.conversation.id, 10);
    expect(recordedVisitorTimeZone(stored?.metadata)).toBe("America/Los_Angeles");
  });

  it("records no zone when the visitor's client reported none, or an unknown one", async () => {
    const { prepare, messages } = await setup("Europe/Rome");

    const unreported = await prepare();
    const unknown = await prepare("Not/AZone");

    for (const session of [unreported, unknown]) {
      const [stored] = await messages.listRecentByConversationId("ws-1", session.conversation.id, 10);
      expect(recordedVisitorTimeZone(stored?.metadata)).toBeNull();
    }
  });
});
