import { describe, expect, it } from "vitest";

import { ChatSessionPreparer } from "../../src/modules/chat/services/chatSessionPreparer.js";
import type { RetrievalTurnPort } from "../../src/modules/chat/services/retrievalTurnDispatch.js";
import { RESPONSE_INTENT } from "../../src/modules/retrieval/public.js";
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
              responseIntent: RESPONSE_INTENT.RETRIEVAL,
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
});
