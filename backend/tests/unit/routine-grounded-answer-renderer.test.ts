import { describe, expect, it, vi } from "vitest";

import type { RoutineStep, TurnContext, TurnOutcome } from "@radioso/conversation-contract";

import {
  createRoutineGroundedAnswerRenderer,
  presentRoutineRenderableAnswer,
} from "../../src/modules/chat/services/routines/routineGroundedAnswerRenderer.js";
import { ChatAnswerPresenter } from "../../src/modules/chat/services/chatAnswerPresenter.js";
import type { PreparedSession } from "../../src/modules/chat/services/chatSessionPreparer.js";
import type { RetrievalPipelineResult } from "../../src/modules/retrieval/public.js";
import {
  RETRIEVAL_OUTCOME_KIND,
  RETRIEVAL_TURN_SKILL,
} from "../../src/modules/chat/services/retrievalTurnSkill.js";
import type { TurnRenderContext, TurnSkill } from "../../src/modules/chat/services/turnOutcome.js";
import type { ChatPresentedAnswer } from "../../src/modules/chat/services/chatAnswerPresenter.js";
import type { ChatSuggestion } from "../../src/modules/chat/types/chatResponses.js";
import type { AssistantSuggestionExpansionService } from "../../src/modules/chat/services/assistantSuggestionExpansionService.js";

const retrievalResult = (): RetrievalPipelineResult =>
  ({
    rewrittenQuery: "kriya module",
    contexts: [{
      documentId: "doc_1",
      chunkId: "chunk_1",
      title: "Course Guide",
      content: "Kriya is introduced in the first module.",
      metadata: { sourceUrl: "https://example.com/guide" },
    }],
    systemPrompt: "retrieval system prompt",
    prompt: "Result 1 (Course Guide): Source: https://example.com/guide\nKriya is introduced in the first module.",
    citations: [],
    responseIdentity: null,
    responseSettings: {
      citationDisplayEnabled: true,
      suggestedQuestionsEnabled: true,
      suggestedQuestionsCount: 3,
      responseLanguagePolicy: "match_user_question",
    },
    diagnostics: {},
    trace: {
      traceId: "retrieval-trace",
      startedAt: "2026-01-01T00:00:00.000Z",
      stages: [],
      links: [],
    },
  } as unknown as RetrievalPipelineResult);

const session = (): PreparedSession =>
  ({
    agent: { id: "agent_1", workspaceId: "workspace_1", name: "Support", chatModelOverride: null },
    conversation: { id: "conv_1", workspaceId: "workspace_1" },
    history: [],
    userMessage: { id: "msg_1", content: "Where is Kriya introduced?" },
    effectiveQuery: "Where is Kriya introduced?",
    turnRoute: "direct",
    responseLanguage: undefined,
    directiveSteering: {
      rules: [{ action: "Use a calm tone.", source: "directive", lifespan: "response" }],
      matches: [],
      omissions: [],
    },
    retrieval: {
      contexts: [],
      diagnostics: {},
      trace: { traceId: "direct", startedAt: "2026-01-01T00:00:00.000Z", stages: [], links: [] },
    },
    stagedContext: [],
    resolvedContext: { fragments: [], renderFragments: [], staged: [], snapshot: {} },
    turnTrace: { traceId: "direct", startedAt: "2026-01-01T00:00:00.000Z", stages: [], links: [] },
  } as unknown as PreparedSession);

const turnWithRetrieval = (retrieval: RetrievalPipelineResult): TurnContext =>
  ({
    agent: { id: "agent_1" },
    sessionId: "conv_1",
    inputEvent: { id: "msg_1", kind: "message", content: "Where is Kriya introduced?" },
    history: [],
    stagedContext: [{
      kind: "skill_result",
      source: "retrieval.context",
      data: { has_context: true },
      metadata: {
        stepId: "retrieve",
        status: "context_ready",
        skillMetadata: { __retrievalResult: retrieval },
      },
    }],
    steering: [],
  });

const step: RoutineStep = {
  id: "answer",
  kind: "chat",
  action: "Answer the question, then say Hop.",
};

describe("createRoutineGroundedAnswerRenderer", () => {
  it("renders staged retrieval through the retrieval turn renderer with routine steering", async () => {
    const render = vi.fn(async (_outcome: TurnOutcome, _ctx: TurnRenderContext): Promise<ChatPresentedAnswer> => ({
      answer: "Kriya is introduced in the first module. Hop!",
      citations: [{
        documentId: "doc_1",
        chunkId: "chunk_1",
        title: "Course Guide",
        sourceUrl: "https://example.com/guide",
      }],
      answerSegments: [{ text: "Kriya is introduced in the first module.", citationIndices: [0] }, { text: " Hop!" }],
      planningCitations: [{
        documentId: "doc_1",
        chunkId: "chunk_1",
        title: "Course Guide",
        sourceUrl: "https://example.com/guide",
      }],
      skillName: RETRIEVAL_TURN_SKILL,
      skillOutcome: "grounded",
      skillStatus: "completed" as const,
      answerOutcome: "grounded_success",
      grounding: "grounded" as const,
    }));
    const retrievalSkill: TurnSkill = {
      definition: { name: RETRIEVAL_TURN_SKILL, outcomeKinds: [RETRIEVAL_OUTCOME_KIND] },
      selects: () => true,
      dispatch: () => {
        throw new Error("dispatch is not used by routine grounded rendering");
      },
      renderer: {
        supports: (outcome) => outcome.kind === RETRIEVAL_OUTCOME_KIND,
        render,
      },
    };
    const retrieval = retrievalResult();
    const renderer = createRoutineGroundedAnswerRenderer({
      session: session(),
      accountId: "acct_1",
      responseLanguage: Promise.resolve("English"),
      turnSkills: [retrievalSkill],
    });

    const result = await renderer.render({
      step,
      steering: [{ action: "Answer the question, then say Hop.", source: "routine", lifespan: "response" }],
      turn: turnWithRetrieval(retrieval),
    });

    expect(render).toHaveBeenCalledOnce();
    expect(render.mock.calls[0]?.[0]).toMatchObject({
      kind: RETRIEVAL_OUTCOME_KIND,
      skillName: RETRIEVAL_TURN_SKILL,
    });
    expect(render.mock.calls[0]?.[1]).toMatchObject({
      accountId: "acct_1",
      query: "Where is Kriya introduced?",
      session: {
        retrieval,
        turnRoute: "retrieval",
        responseLanguage: "English",
        directiveSteering: {
          rules: [
            expect.objectContaining({ action: "Use a calm tone.", source: "directive" }),
            expect.objectContaining({ action: "Answer the question, then say Hop.", source: "routine" }),
          ],
        },
      },
    });
    expect(result).toMatchObject({
      answer: "Kriya is introduced in the first module. Hop!",
      metadata: {
        skillName: RETRIEVAL_TURN_SKILL,
        skillOutcome: "grounded",
        skillStatus: "completed",
        answerOutcome: "grounded_success",
        answerSegments: [{ text: "Kriya is introduced in the first module.", citationIndices: [0] }, { text: " Hop!" }],
        grounding: "grounded",
        effectiveRetrieval: retrieval,
      },
    });
  });

  it("declines when no staged retrieval result is available", async () => {
    const renderer = createRoutineGroundedAnswerRenderer({
      session: session(),
      turnSkills: [],
    });

    await expect(renderer.render({
      step,
      steering: [],
      turn: { ...turnWithRetrieval(retrievalResult()), stagedContext: [] },
    })).resolves.toBeNull();
  });
});

describe("presentRoutineRenderableAnswer", () => {
  it("uses pre-presented grounded metadata instead of recomputing routine citations", () => {
    const presenter = new ChatAnswerPresenter({
      apply() {
        return { suggestions: [] as ChatSuggestion[] };
      },
    } as unknown as AssistantSuggestionExpansionService);

    const result = presentRoutineRenderableAnswer(presenter, {
      answer: "Kriya is introduced in the first module.",
      citations: [{ documentId: "doc_1", chunkId: "chunk_1", title: "Course Guide" }],
      metadata: {
        skillName: RETRIEVAL_TURN_SKILL,
        skillOutcome: "grounded",
        skillStatus: "completed",
        answerOutcome: "grounded_success",
        answerSegments: [{ text: "Kriya is introduced in the first module.", citationIndices: [0] }],
        effectiveRetrieval: retrievalResult(),
      },
    });

    expect(result).toMatchObject({
      skillName: RETRIEVAL_TURN_SKILL,
      skillOutcome: "grounded",
      answerOutcome: "grounded_success",
      answerSegments: [{ text: "Kriya is introduced in the first module.", citationIndices: [0] }],
      effectiveRetrieval: expect.objectContaining({
        rewrittenQuery: "kriya module",
        systemPrompt: "retrieval system prompt",
      }),
    });
  });
});
