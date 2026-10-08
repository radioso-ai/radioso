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
  createRetrievalTurnSkill,
  RetrievalAnswerComposer,
  RETRIEVAL_OUTCOME_KIND,
  RETRIEVAL_TURN_SKILL,
} from "../../src/modules/chat/services/retrievalTurnSkill.js";
import { ChatAnswerSupport } from "../../src/modules/chat/services/chatAnswerSupport.js";
import type { ChatGateway } from "../../src/modules/chat/contracts/chatGateway.js";
import { renderSteeringBlock } from "../../src/shared/infra/prompts/steeringPromptRenderer.js";
import type { TurnRenderContext, TurnSkill } from "../../src/modules/chat/services/turnOutcome.js";
import type { ChatPresentedAnswer } from "../../src/modules/chat/services/chatAnswerPresenter.js";
import type { ChatSuggestion } from "../../src/modules/chat/types/chatResponses.js";
import { AssistantSuggestionExpansionService } from "../../src/modules/chat/services/assistantSuggestionExpansionService.js";

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

  it("composes a retrieval-fed step's grounded prompt with the step as the controlling instruction (#1351)", async () => {
    const systemPrompts: string[] = [];
    const gateway: ChatGateway = {
      async answer(input) {
        systemPrompts.push(input.systemPrompt ?? "");
        return JSON.stringify({
          coverage: "answered_sufficient_evidence",
          requestFocus: "where Kriya is introduced",
          outcome: "answer",
          answer: "Kriya is introduced in the first module[[1]]. What email address can we reach you at?",
          v: 2,
          claims: [[1]],
          suggestions: [],
          grounding: "grounded",
        });
      },
      async *streamAnswer() {
        throw new Error("routine grounded rendering uses the non-streaming path");
      },
    };
    const composer = new RetrievalAnswerComposer(
      new ChatAnswerSupport(),
      gateway,
      new ChatAnswerPresenter(new AssistantSuggestionExpansionService(), undefined, { supportsGroundedAnswer: () => true }),
      { async composeNoContext() { throw new Error("the staged retrieval has context"); } },
    );
    const stepAction = "Answer where Kriya is introduced, then ask what email address we can reach them at.";
    const redirect = {
      id: "directive-form",
      directiveName: "contact-form-only",
      action: "Send anyone who needs a follow-up to the contact form at https://example.com/contact.",
      source: "directive" as const,
      lifespan: "response" as const,
      priority: 50,
    };
    const renderer = createRoutineGroundedAnswerRenderer({
      session: { ...session(), directiveSteering: { rules: [], matches: [], omissions: [] } },
      turnSkills: [createRetrievalTurnSkill(composer)],
    });

    await renderer.render({
      step: { ...step, action: stepAction },
      steering: [{ action: stepAction, source: "routine", lifespan: "response" }, redirect],
      turn: turnWithRetrieval(retrievalResult()),
    });

    const systemPrompt = systemPrompts[0] ?? "";
    expect(systemPrompts).toHaveLength(1);
    expect(systemPrompt).toContain(renderSteeringBlock([redirect, { action: stepAction, source: "routine", lifespan: "response" }], { includeRuleIds: true }));
    expect(systemPrompt).toContain("subordinate to the step");
    expect(systemPrompt).toContain(`[directive-form] ${redirect.action}`);
    expect(systemPrompt.indexOf("Step instruction(s) — the controlling instruction")).toBeLessThan(systemPrompt.indexOf(redirect.action));
    expect(systemPrompt).not.toContain("govern the visible answer");
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

  describe("prepare", () => {
    const presented = (): ChatPresentedAnswer => ({
      answer: "Kriya is introduced in the first module. Hop!",
      skillName: RETRIEVAL_TURN_SKILL,
      skillOutcome: "grounded",
      skillStatus: "completed" as const,
      grounding: "grounded" as const,
    });
    const retrievalSkillRendering = (render: TurnSkill["renderer"]["render"]): TurnSkill => ({
      definition: { name: RETRIEVAL_TURN_SKILL, outcomeKinds: [RETRIEVAL_OUTCOME_KIND] },
      selects: () => true,
      dispatch: () => {
        throw new Error("dispatch is not used by routine grounded rendering");
      },
      renderer: { supports: (outcome) => outcome.kind === RETRIEVAL_OUTCOME_KIND, render },
    });

    it("declines at once, from the staged context alone, when no retrieval result was staged", () => {
      const renderer = createRoutineGroundedAnswerRenderer({ session: session(), turnSkills: [] });

      expect(renderer.prepare!({
        step,
        steering: [],
        turn: { ...turnWithRetrieval(retrievalResult()), stagedContext: [] },
      })).toBeNull();
    });

    it("generates nothing until asked, then renders what render() renders", async () => {
      const render = vi.fn(async (): Promise<ChatPresentedAnswer> => presented());
      const options = {
        session: session(),
        accountId: "acct_1",
        responseLanguage: Promise.resolve("English"),
        turnSkills: [retrievalSkillRendering(render)],
      };
      const retrieval = retrievalResult();
      const input = {
        step,
        steering: [{ action: "Answer the question, then say Hop.", source: "routine" as const, lifespan: "response" as const }],
        turn: turnWithRetrieval(retrieval),
      };

      const reply = createRoutineGroundedAnswerRenderer(options).prepare!(input);
      expect(render).not.toHaveBeenCalled();
      const prepared = await reply!.render();
      const rendered = await createRoutineGroundedAnswerRenderer(options).render(input);

      expect(prepared).toEqual(rendered);
      expect(render).toHaveBeenCalledTimes(2);
      expect(render.mock.calls[0]).toEqual(render.mock.calls[1]);
    });
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
