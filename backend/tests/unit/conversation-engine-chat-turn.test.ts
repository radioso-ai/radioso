import { describe, expect, it, vi } from "vitest";

import type {
  AnswerCoverageAssessment,
  ConversationCoverageReactionRecorder,
  ConversationEngine,
} from "@radioso/conversation-contract";
import { DefaultConversationEngine } from "@radioso/conversation-engine";
import type { ConversationRecord } from "../../src/db/repositories/conversationRepository.js";
import type { MessageRecord } from "../../src/db/repositories/messageRepository.js";
import type { AgentRecord } from "../../src/modules/agents/public.js";
import type { PreparedSession } from "../../src/modules/chat/services/chatSessionPreparer.js";
import {
  attemptRoutineTurnWithConversationEngine,
  type RunPreparedChatTurnStreamWithConversationEngineEvent,
  runPreparedChatTurnStreamWithConversationEngine,
  runPreparedChatTurnWithConversationEngine,
} from "../../src/modules/chat/services/conversationEngineChatTurn.js";
import type { ChatAnswerPresenter, ChatPresentedAnswer } from "../../src/modules/chat/services/chatAnswerPresenter.js";
import type { ProcessTurnResult } from "@radioso/conversation-contract";
import type { TurnSkill } from "../../src/modules/chat/services/turnOutcome.js";
import {
  RETRIEVAL_OUTCOME_KIND,
  RETRIEVAL_TURN_SKILL,
  buildRetrievalTurnOutcome,
} from "../../src/modules/chat/services/retrievalTurnSkill.js";
import {
  DefaultTurnSelectionStrategy,
  type TurnSelectionStrategy,
} from "../../src/modules/chat/services/turnSelectionStrategy.js";
import {
  toConversationTrace,
  toPreparedStagedContext,
} from "../../src/modules/chat/services/conversationContractMappers.js";
import { ChatTurnSkillSelector } from "../../src/modules/chat/services/turnSkillSelector.js";
import {
  createRouteScopedDirectiveSteering,
  type RouteScopedDirectiveRuntime,
} from "../../src/modules/chat/services/routeScopedDirectiveSteering.js";
import { DefaultAllowCapabilityPolicy } from "../../src/shared/domain/capabilityPolicy.js";
import type {
  Directive,
  DirectiveSteerInput,
  DirectiveSteeringResult,
} from "../../src/modules/directives/public.js";
import type { ActivityTrace, RetrievalPipelineResult } from "../../src/modules/retrieval/public.js";
import { appendDirectiveSteeringStage } from "../../src/modules/chat/contracts/index.js";
import {
  attestableSteering,
  composeGroundedAnswerSystemPrompt,
} from "../../src/modules/chat/services/groundedAnswerPromptComposer.js";
import { ModelInferencePipelineService } from "../../src/shared/infra/llm/modelInferencePipeline.js";
import {
  createModelCallTraceCollector,
  runAsyncIterableWithModelCallTrace,
  runWithModelCallTrace,
} from "../../src/shared/observability/tracing/modelCallTraceContext.js";
import { buildTurnTraceEnvelope } from "../../src/modules/chat/services/turnTraceEnvelope.js";
import { unpublishedAgentPublicIdentity } from "../../src/modules/agents/public.js";

const conversation = (): ConversationRecord => ({
  id: "conv_1",
  workspaceId: "workspace_1",
  agentId: "agent_1",
  purpose: "production",
  agentName: "Support",
  agentInternalName: null,
  sourceChannel: null,
  sourceOrigin: null,
  channelContext: null,
  anonymousSessionId: null,
  verifiedCustomerId: null,
  entryPageUrl: null,
  title: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
});

const message = (overrides: Partial<MessageRecord> = {}): MessageRecord => ({
  id: "msg_1",
  conversationId: "conv_1",
  workspaceId: "workspace_1",
  role: "user",
  content: "Where is my order?",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  ...overrides,
});

const agent = (): AgentRecord => ({
  ...unpublishedAgentPublicIdentity(),
  id: "agent_1",
  workspaceId: "workspace_1",
  name: "Support",
  customInstruction: "",
  suggestedQuestionsEnabled: true,
  assistantLinkUtmEnabled: true,
  citationDisplayEnabled: true,
  contactRequestsEnabled: false,
  webhookExportsEnabled: false,
  contactRequestDelivery: { recipientEmails: [], webhook: null },
  retrievalEnabled: true,
  sourceScope: { mode: "all" },
  skillSettings: {},
  logo: null,
  theme: {
    brand: "#000000",
    brandText: "#ffffff",
    surface: "#ffffff",
    text: "#000000",
  },
  branding: {
    hidePoweredBy: false,
    privacyPolicyUrl: null,
  },
  greetingInstruction: "",
  assistantDefaultLocale: null,
  proactiveGreetingEnabled: false,
  chatModelOverride: null,
  surfaceSettings: {
    authenticatedChat: { enabled: true },
    anonymousChat: { enabled: false, token: null },
    websiteEmbed: {
      enabled: false,
      token: null,
      allowedOrigins: [],
      launcherLabel: "Chat",
      launcherPosition: "bottom-right",
      theme: {
        brand: "#000000",
        brandText: "#ffffff",
        surface: "#ffffff",
        text: "#000000",
      },
      copy: {},
      expertOverrides: {},
    },
    extensions: {},
  },
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
});

const retrievalResult = (): RetrievalPipelineResult =>
  ({
    contexts: [],
    diagnostics: {},
    trace: {
      traceId: "trace_1",
      startedAt: "2026-01-01T00:00:00.000Z",
      stages: [],
      links: [],
    },
  } as unknown as RetrievalPipelineResult);

const session = (): PreparedSession => {
  const retrieval = retrievalResult();
  const userMessage = message();
  return {
    agent: agent(),
    conversation: conversation(),
    history: [],
    retrieval,
    turnRoute: "direct",
    userMessage,
    effectiveQuery: userMessage.content,
    directiveSteering: {
      rules: [],
      matches: [],
      omissions: [],
    },
    stagedContext: [toPreparedStagedContext(retrieval)],
    resolvedContext: { fragments: [], renderFragments: [], staged: [], snapshot: {} },
    turnTrace: toConversationTrace(retrieval.trace),
  };
};

// These adapter tests render through injected terminal skills. A presenter is
// still part of the host contract for the routine-only fallback, which none of
// these cases exercise.
const chatAnswerPresenter = {} as ChatAnswerPresenter;

describe("attemptRoutineTurnWithConversationEngine", () => {
  const routinePorts = {
    routineStore: { loadActive: async () => null, save: async () => {}, clear: async () => {} },
    routineRunner: { resume: async () => ({ response: { answer: "" }, nextState: null }) },
    routineActivator: { activate: async () => null },
    presentRoutineReply: (response: { answer: string }): ChatPresentedAnswer =>
      ({ answer: response.answer, skillName: "routine", skillOutcome: "routine", skillStatus: "completed" }),
  };
  const engineWith = (result: ProcessTurnResult | null): ConversationEngine =>
    ({
      attemptRoutine: async () => result,
      processTurn: async () => {
        throw new Error("processTurn should not run when attempting a routine");
      },
      processTurnStream: async function* () {
        throw new Error("processTurnStream should not run when attempting a routine");
      },
      resumeAwaitingDecision: async () => ({ resumed: false, response: { answer: "" }, nextState: null }),
    });

  it("presents the routine reply when the engine claims the turn", async () => {
    const result = {
      sessionId: "conv_1",
      events: [],
      decision: { selected: [], reason: "routine_activated:contact.request" },
      outcomes: [],
      response: { answer: "What is your email?" },
      trace: { traceId: "t", startedAt: "x", stages: [] },
      actions: [{ type: "contact.send", payload: { email: "a@b.c" } }],
    } as unknown as ProcessTurnResult;
    const outcome = await attemptRoutineTurnWithConversationEngine({
      engine: engineWith(result),
      session: session(),
      ...routinePorts,
    });
    expect(outcome?.presentation.answer).toBe("What is your email?");
    expect(outcome?.result.actions).toEqual([{ type: "contact.send", payload: { email: "a@b.c" } }]);
  });

  it("returns null when no routine claims the turn (so the host falls through to grounding)", async () => {
    const outcome = await attemptRoutineTurnWithConversationEngine({
      engine: engineWith(null),
      session: session(),
      ...routinePorts,
    });
    expect(outcome).toBeNull();
  });
});

// A fake engine that drives the adapter's ports the way the real engine does:
// select, dispatch the selected skill, then compose. Records what was dispatched.
const drivingEngine = (): { engine: ConversationEngine; dispatched: string[]; selectorCalls: number[] } => {
  const dispatched: string[] = [];
  const selectorCalls: number[] = [];
  const engine: ConversationEngine = {
    async attemptRoutine() {
      return null;
    },
    async resumeAwaitingDecision() {
      return { resumed: false, response: { answer: "" }, nextState: null };
    },
    async processTurn(input) {
      const history = await input.stores.loadHistory({ sessionId: input.sessionId });
      const turn = {
        agent: input.agent,
        sessionId: input.sessionId,
        inputEvent: input.inputEvent,
        history,
        stagedContext: [],
        steering: [],
      };
      const decision = await input.selector.select({ turn, skills: input.skills, directives: [] });
      selectorCalls.push(decision.selected.length);
      const selected = decision.selected[0];
      const skill = input.skills.find((candidate) => candidate.name === selected?.skillName);
      if (!skill || !selected) {
        throw new Error("test skill selection failed");
      }
      const outcome = await input.dispatcher.dispatch({ skill, turn, selected });
      dispatched.push(outcome.skillName);
      const response = await input.composer.compose({ turn, outcomes: [outcome], decision });
      return {
        sessionId: input.sessionId,
        events: [],
        decision,
        outcomes: [outcome],
        response,
        trace: { traceId: "test-engine", startedAt: "2026-01-01T00:00:00.000Z", stages: [] },
      };
    },
    async *processTurnStream(input) {
      const result = await this.processTurn(input);
      yield { type: "final", result };
    },
  };
  return { engine, dispatched, selectorCalls };
};

describe("runPreparedChatTurnWithConversationEngine", () => {
  it("presents a typed coverage routine clarification without requiring a routine execution", async () => {
    const result: ProcessTurnResult = {
      sessionId: "conv_1",
      events: [],
      decision: { selected: [], reason: "routine_activation_clarification" },
      outcomes: [],
      response: {
        answer: "Would you like a consultation or a callback?",
        metadata: { skillName: "routine", skillOutcome: "clarification", skillStatus: "completed" },
      },
      routineClarificationRoutineIds: ["consultation", "callback"],
      trace: { traceId: "clarification", startedAt: new Date(0).toISOString(), stages: [] },
    };
    const engine: ConversationEngine = {
      attemptRoutine: async () => null,
      processTurn: async () => result,
      resumeAwaitingDecision: async () => ({ resumed: false, response: { answer: "" }, nextState: null }),
      async *processTurnStream() { yield { type: "final" as const, result }; },
    };
    const input = {
      engine,
      session: session(),
      chatAnswerPresenter,
      turnSkillSelector: new ChatTurnSkillSelector([], new DefaultTurnSelectionStrategy()),
      turnSkills: [],
      query: "Arrange help",
    };

    await expect(runPreparedChatTurnWithConversationEngine(input)).resolves.toMatchObject({
      presentation: { answer: "Would you like a consultation or a callback?" },
    });
    const events: RunPreparedChatTurnStreamWithConversationEngineEvent[] = [];
    for await (const event of runPreparedChatTurnStreamWithConversationEngine(input)) events.push(event);
    expect(events).toContainEqual(expect.objectContaining({
      type: "final",
      presentation: expect.objectContaining({ answer: "Would you like a consultation or a callback?" }),
    }));
  });

  // A skill standing in for the retrieval skill's real behavior (#1260): it
  // reports a fixed coverage verdict to the engine's sink, from inside its own
  // render/stream, before producing anything. Exercises the real engine so the
  // sink is genuinely constructed and forwarded end to end, not faked.
  const coverageReportingSkill = (assessment: AnswerCoverageAssessment): TurnSkill => ({
    definition: { name: "answer", outcomeKinds: ["generic"] },
    selects: () => true,
    dispatch: () => ({
      kind: "generic",
      skillName: "answer",
      outcome: { status: "completed", answer: "The skill's own answer." },
      stagedContext: [],
      steering: [],
      trace: { traceId: "skill", startedAt: new Date(0).toISOString(), stages: [] },
    }),
    renderer: {
      supports: (outcome) => outcome.kind === "generic",
      async render(outcome, ctx) {
        const decision = await ctx.coverageVerdict?.report({ assessment });
        return decision?.decision === "yield_turn"
          ? { answer: "", yielded: true, skillName: "answer", skillOutcome: "yielded", skillStatus: "completed" }
          : { answer: outcome.outcome.answer ?? "", skillName: "answer", skillOutcome: "completed", skillStatus: "completed" };
      },
      async *stream(outcome, ctx) {
        const decision = await ctx.coverageVerdict?.report({ assessment });
        if (decision?.decision === "yield_turn") {
          return {
            finalPresentation: { answer: "", yielded: true, skillName: "answer", skillOutcome: "yielded", skillStatus: "completed" },
            suggestions: { mode: "presentation" as const },
            hasStreamedAnswer: false,
            streamedAnswer: "",
            yielded: true,
          };
        }
        yield outcome.outcome.answer ?? "";
        return {
          finalPresentation: { answer: outcome.outcome.answer ?? "", skillName: "answer", skillOutcome: "completed", skillStatus: "completed" },
          suggestions: { mode: "presentation" as const },
          hasStreamedAnswer: true,
          streamedAnswer: outcome.outcome.answer ?? "",
        };
      },
    },
  });

  const unansweredAssessment: AnswerCoverageAssessment = {
    availability: "assessed",
    coverage: "unanswered",
    reason: "insufficient_evidence",
    schemaVersion: 1,
    producer: "answer_head",
  };

  const coverageRoutinePorts = {
    coverageRoutineActivator: {
      evaluateCandidates: () => [{ routineId: "support", decision: "candidate" as const, reasonCode: "coverage_criteria_candidate" }],
      activate: async () => ({ kind: "activate" as const, routineId: "support" }),
    },
    routineStore: { loadActive: async () => null, save: async () => {}, clear: async () => {} },
    routineRunner: { resume: async () => ({ response: { answer: "I can connect you with support." }, nextState: null }) },
  };

  it("presents the post-evidence routine's answer, not the skill's, when the reported coverage verdict yields the turn", async () => {
    const turnSkills = [coverageReportingSkill(unansweredAssessment)];
    const { presentation, result } = await runPreparedChatTurnWithConversationEngine({
      engine: new DefaultConversationEngine(),
      session: session(),
      chatAnswerPresenter: { presentRoutineAnswer: (answer: string) => ({ answer, skillName: "routine", skillOutcome: "completed", skillStatus: "completed" }) } as unknown as ChatAnswerPresenter,
      turnSkillSelector: new ChatTurnSkillSelector(turnSkills, new DefaultTurnSelectionStrategy()),
      turnSkills,
      query: "Where is my order?",
      ...coverageRoutinePorts,
    });

    expect(presentation.answer).toBe("I can connect you with support.");
    expect(result.trace.stages.find((stage) => stage.kind === "compose")).toMatchObject({
      outputs: expect.objectContaining({ yielded: true }),
    });
  });

  it("streams nothing from the skill and presents the routine's committed answer when the reported coverage verdict yields the turn", async () => {
    const turnSkills = [coverageReportingSkill(unansweredAssessment)];
    const events: RunPreparedChatTurnStreamWithConversationEngineEvent[] = [];
    for await (const event of runPreparedChatTurnStreamWithConversationEngine({
      engine: new DefaultConversationEngine(),
      session: session(),
      chatAnswerPresenter: { presentRoutineAnswer: (answer: string) => ({ answer, skillName: "routine", skillOutcome: "completed", skillStatus: "completed" }) } as unknown as ChatAnswerPresenter,
      turnSkillSelector: new ChatTurnSkillSelector(turnSkills, new DefaultTurnSelectionStrategy()),
      turnSkills,
      query: "Where is my order?",
      ...coverageRoutinePorts,
    })) {
      events.push(event);
    }

    const chunks = events.filter((event) => event.type === "chunk");
    // The one delta that streams is the routine's committed answer, not the
    // skill's own text — the skill's stream released nothing before yielding.
    expect(chunks.map((event) => event.text)).toEqual(["I can connect you with support."]);
    const final = events.find((event) => event.type === "final");
    if (!final || final.type !== "final") {
      throw new Error("expected a final event");
    }
    expect(final.presentation.answer).toBe("I can connect you with support.");
    expect(final.engineTrace.stages.find((stage) => stage.kind === "compose")).toMatchObject({
      outputs: expect.objectContaining({ yielded: true }),
    });
  });

  it("yields mapped, deduplicated progress while the engine remains blocked", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const result = {
      sessionId: "conv_1",
      events: [],
      decision: { selected: [], reason: "test" },
      outcomes: [],
      response: { answer: "Done" },
      trace: { traceId: "trace", startedAt: new Date(0).toISOString(), stages: [] },
    } as ProcessTurnResult;
    const engine: ConversationEngine = {
      attemptRoutine: async () => null,
      processTurn: async () => result,
      resumeAwaitingDecision: async () => ({ resumed: false, response: { answer: "" }, nextState: null }),
      async *processTurnStream(input) {
        input.progress?.report({ phase: "interpreting" });
        input.progress?.report({ phase: "preparing" });
        await blocked;
        input.progress?.report({ phase: "selecting" });
        input.progress?.report({ phase: "composing" });
        yield { type: "final", result };
      },
    };
    const turnSkill: TurnSkill = {
      definition: { name: "answer.direct", outcomeKinds: ["answer"] },
      selects: () => true,
      dispatch: () => ({
        kind: "answer",
        skillName: "answer.direct",
        outcome: { status: "completed", answer: "Done" },
        stagedContext: [],
        steering: [],
        trace: { traceId: "skill", startedAt: new Date(0).toISOString(), stages: [] },
      }),
      renderer: {
        supports: () => true,
        render: async () => ({
          answer: "Done",
          skillName: "answer.direct",
          skillOutcome: "completed",
          skillStatus: "completed",
        }),
      },
    };
    const events = runPreparedChatTurnStreamWithConversationEngine({
      engine,
      session: session(),
      chatAnswerPresenter,
      turnSkillSelector: new ChatTurnSkillSelector([turnSkill], new DefaultTurnSelectionStrategy()),
      turnSkills: [turnSkill],
      query: "Question",
    })[Symbol.asyncIterator]();

    await expect(events.next()).resolves.toMatchObject({
      value: { type: "status", stage: "interpreting" },
      done: false,
    });
    release();
    await expect(events.next()).resolves.toMatchObject({
      value: { type: "status", stage: "composing" },
      done: false,
    });
  });

  it("discards deltas queued by a completed pump when cancellation wins before the first chunk", async () => {
    const controller = new AbortController();
    const turnSkill: TurnSkill = {
      definition: { name: "answer.direct", outcomeKinds: ["answer"] },
      selects: () => true,
      dispatch: () => ({
        kind: "answer",
        skillName: "answer.direct",
        outcome: { status: "completed", answer: "PRIVATE ANSWER" },
        stagedContext: [],
        steering: [],
        trace: { traceId: "skill", startedAt: new Date(0).toISOString(), stages: [] },
      }),
      renderer: {
        supports: () => true,
        render: async () => ({
          answer: "PRIVATE ANSWER",
          skillName: "answer.direct",
          skillOutcome: "completed",
          skillStatus: "completed",
        }),
      },
    };
    const events = runPreparedChatTurnStreamWithConversationEngine({
      engine: new DefaultConversationEngine(),
      session: session(),
      chatAnswerPresenter,
      turnSkillSelector: new ChatTurnSkillSelector([turnSkill], new DefaultTurnSelectionStrategy()),
      turnSkills: [turnSkill],
      query: "Question",
      signal: controller.signal,
    })[Symbol.asyncIterator]();

    await expect(events.next()).resolves.toMatchObject({
      value: { type: "status", stage: "composing" },
      done: false,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const superseded = new Error("superseded_before_first_chunk");
    controller.abort(superseded);

    await expect(events.next()).rejects.toBe(superseded);
    await expect(events.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("does not start queued engine delivery when the signal is already aborted", async () => {
    const controller = new AbortController();
    const superseded = new Error("already_superseded");
    controller.abort(superseded);
    const turnSkill: TurnSkill = {
      definition: { name: "answer.direct", outcomeKinds: ["answer"] },
      selects: () => true,
      dispatch: () => ({
        kind: "answer",
        skillName: "answer.direct",
        outcome: { status: "completed", answer: "PRIVATE" },
        stagedContext: [],
        steering: [],
        trace: { traceId: "skill", startedAt: new Date(0).toISOString(), stages: [] },
      }),
      renderer: {
        supports: () => true,
        render: async () => ({
          answer: "PRIVATE",
          skillName: "answer.direct",
          skillOutcome: "completed",
          skillStatus: "completed",
        }),
      },
    };
    const events = runPreparedChatTurnStreamWithConversationEngine({
      engine: new DefaultConversationEngine(),
      session: session(),
      chatAnswerPresenter,
      turnSkillSelector: new ChatTurnSkillSelector([turnSkill], new DefaultTurnSelectionStrategy()),
      turnSkills: [turnSkill],
      query: "Question",
      signal: controller.signal,
    })[Symbol.asyncIterator]();

    await expect(events.next()).rejects.toBe(superseded);
    await expect(events.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("delivers cancellation immediately while the pump owns a blocked engine next", async () => {
    const controller = new AbortController();
    const superseded = new Error("superseded_while_engine_blocked");
    let rejectEngineNext!: (error: unknown) => void;
    const blockedNext = new Promise<IteratorResult<never>>((_resolve, reject) => {
      rejectEngineNext = reject;
    });
    const engineIterator = {
      next: vi.fn(() => blockedNext),
      return: vi.fn(async () => ({ done: true, value: undefined })),
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    const result = {
      sessionId: "conv_1",
      events: [],
      decision: { selected: [], reason: "test" },
      outcomes: [],
      response: { answer: "unused" },
      trace: { traceId: "trace", startedAt: new Date(0).toISOString(), stages: [] },
    } as ProcessTurnResult;
    const engine: ConversationEngine = {
      attemptRoutine: async () => null,
      processTurn: async () => result,
      resumeAwaitingDecision: async () => ({ resumed: false, response: { answer: "" }, nextState: null }),
      processTurnStream: vi.fn(() => engineIterator) as never,
    };
    const turnSkill: TurnSkill = {
      definition: { name: "answer.direct", outcomeKinds: ["answer"] },
      selects: () => true,
      dispatch: () => ({
        kind: "answer",
        skillName: "answer.direct",
        outcome: { status: "completed", answer: "unused" },
        stagedContext: [],
        steering: [],
        trace: { traceId: "skill", startedAt: new Date(0).toISOString(), stages: [] },
      }),
      renderer: {
        supports: () => true,
        render: async () => ({
          answer: "unused",
          skillName: "answer.direct",
          skillOutcome: "completed",
          skillStatus: "completed",
        }),
      },
    };
    const events = runPreparedChatTurnStreamWithConversationEngine({
      engine,
      session: session(),
      chatAnswerPresenter,
      turnSkillSelector: new ChatTurnSkillSelector([turnSkill], new DefaultTurnSelectionStrategy()),
      turnSkills: [turnSkill],
      query: "Question",
      signal: controller.signal,
    })[Symbol.asyncIterator]();

    const pending = events.next();
    await vi.waitFor(() => expect(engineIterator.next).toHaveBeenCalledOnce());
    controller.abort(superseded);

    await expect(pending).rejects.toBe(superseded);
    expect(engineIterator.return).not.toHaveBeenCalled();

    rejectEngineNext(new Error("blocked_stage_failed_after_cancellation"));
    await vi.waitFor(() => expect(engineIterator.return).toHaveBeenCalledOnce());
  });

  it("contains a rejecting engine return in the pump shutdown path", async () => {
    const controller = new AbortController();
    const superseded = new Error("superseded_before_rejecting_return");
    let settleEngineNext!: (result: IteratorResult<never>) => void;
    const blockedNext = new Promise<IteratorResult<never>>((resolve) => {
      settleEngineNext = resolve;
    });
    const returnError = new Error("engine_return_failed");
    const engineIterator = {
      next: vi.fn(() => blockedNext),
      return: vi.fn(async () => {
        throw returnError;
      }),
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    const result = {
      sessionId: "conv_1",
      events: [],
      decision: { selected: [], reason: "test" },
      outcomes: [],
      response: { answer: "unused" },
      trace: { traceId: "trace", startedAt: new Date(0).toISOString(), stages: [] },
    } as ProcessTurnResult;
    const engine: ConversationEngine = {
      attemptRoutine: async () => null,
      processTurn: async () => result,
      resumeAwaitingDecision: async () => ({ resumed: false, response: { answer: "" }, nextState: null }),
      processTurnStream: vi.fn(() => engineIterator) as never,
    };
    const turnSkill: TurnSkill = {
      definition: { name: "answer.direct", outcomeKinds: ["answer"] },
      selects: () => true,
      dispatch: () => ({
        kind: "answer",
        skillName: "answer.direct",
        outcome: { status: "completed", answer: "unused" },
        stagedContext: [],
        steering: [],
        trace: { traceId: "skill", startedAt: new Date(0).toISOString(), stages: [] },
      }),
      renderer: {
        supports: () => true,
        render: async () => ({
          answer: "unused",
          skillName: "answer.direct",
          skillOutcome: "completed",
          skillStatus: "completed",
        }),
      },
    };
    const unhandled: unknown[] = [];
    const recordUnhandled = (error: unknown) => {
      unhandled.push(error);
    };
    process.on("unhandledRejection", recordUnhandled);
    try {
      const events = runPreparedChatTurnStreamWithConversationEngine({
        engine,
        session: session(),
      chatAnswerPresenter,
        turnSkillSelector: new ChatTurnSkillSelector([turnSkill], new DefaultTurnSelectionStrategy()),
        turnSkills: [turnSkill],
        query: "Question",
        signal: controller.signal,
      })[Symbol.asyncIterator]();

      const pending = events.next();
      await vi.waitFor(() => expect(engineIterator.next).toHaveBeenCalledOnce());
      controller.abort(superseded);
      await expect(pending).rejects.toBe(superseded);
      settleEngineNext({ done: true, value: undefined });
      await vi.waitFor(() => expect(engineIterator.return).toHaveBeenCalledOnce());
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(engineIterator.return).toHaveBeenCalledOnce();
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", recordUnhandled);
    }
  });

  it("attaches answer model identity, latency, operation, and tokens to the compose stage", async () => {
    const inference = new ModelInferencePipelineService({
      metadata: { capability: "chat", provider: "openai", model: "gpt-answer" },
      complete: vi.fn(async () => ({
        text: "Composed answer.",
        usage: { inputTokens: 30, outputTokens: 8, totalTokens: 38, quality: "actual" as const },
      })),
      stream: vi.fn(),
    });
    const answerSkill: TurnSkill = {
      definition: { name: "answer.direct", outcomeKinds: ["answer"] },
      selects: () => true,
      dispatch: () => ({
        kind: "answer",
        skillName: "answer.direct",
        outcome: { status: "completed" },
        stagedContext: [],
        steering: [],
        trace: { traceId: "skill", startedAt: new Date(0).toISOString(), stages: [] },
      }),
      renderer: {
        supports: () => true,
        render: async (outcome) => ({
          answer: (await inference.complete({
            operation: {
              workspaceId: "workspace_1",
              surface: "assistant",
              operation: "direct_answer",
              attemptKey: "msg_1:answer",
            },
            prompt: "private prompt",
          })).text,
          skillName: outcome.skillName,
          skillOutcome: "completed",
          skillStatus: "completed",
        }),
      },
    };
    const base = drivingEngine().engine;
    const engine: ConversationEngine = {
      ...base,
      async processTurn(input) {
        const result = await base.processTurn(input);
        const compose = result.trace.stages.find((stage) => stage.kind === "compose");
        if (!compose) {
          result.trace.stages.push({
            id: "compose",
            kind: "compose",
            status: "applied",
            startedAt: new Date(Date.now() - 1_000).toISOString(),
            completedAt: new Date(Date.now() + 1_000).toISOString(),
          });
        }
        return result;
      },
    };

    const collector = createModelCallTraceCollector();
    const { result } = await runWithModelCallTrace(collector, () =>
      runPreparedChatTurnWithConversationEngine({
        engine,
        session: session(),
      chatAnswerPresenter,
        turnSkillSelector: new ChatTurnSkillSelector([answerSkill], new DefaultTurnSelectionStrategy()),
        turnSkills: [answerSkill],
        query: "Answer directly",
      }));
    const envelope = buildTurnTraceEnvelope({ spine: result.trace, modelCallTrace: collector });

    expect(envelope.spine.stages.find((stage) => stage.kind === "compose")).toMatchObject({
      inputs: { operation: "direct_answer", model: "gpt-answer" },
      metrics: {
        llmCallCount: 1,
        inputTokens: 30,
        outputTokens: 8,
        totalTokens: 38,
      },
      outputs: {
        modelCallIds: ["model_call_1"],
      },
    });
    expect(envelope.spine.stages.find((stage) => stage.kind === "model_calls")?.outputs?.modelCalls)
      .toEqual([expect.objectContaining({
        id: "model_call_1",
        operation: "direct_answer",
        model: "gpt-answer",
        inputTokens: 30,
        outputTokens: 8,
        stageId: "compose",
      })]);
  });

  it("lets the engine select and dispatch the registered retrieval skill, then renders it", async () => {
    // The retrieval skill is injected as skill-shaped input — the adapter names no
    // skill itself. The renderer stands in for the host's grounded composition.
    const retrievalSkill: TurnSkill = {
      definition: { name: RETRIEVAL_TURN_SKILL, outcomeKinds: [RETRIEVAL_OUTCOME_KIND] },
      selects: () => true,
      dispatch: (s) => buildRetrievalTurnOutcome(s),
      renderer: {
        supports: (outcome) => outcome.kind === RETRIEVAL_OUTCOME_KIND,
        render: async (outcome) => ({
          answer: "Grounded answer.",
          skillName: outcome.skillName,
          skillOutcome: outcome.outcome.status,
          skillStatus: outcome.outcome.status,
        }),
      },
    };

    const { engine, dispatched, selectorCalls } = drivingEngine();
    const turnSkills = [retrievalSkill];
    const { presentation, result } = await runPreparedChatTurnWithConversationEngine({
      engine,
      session: session(),
      chatAnswerPresenter,
      turnSkillSelector: new ChatTurnSkillSelector(turnSkills, new DefaultTurnSelectionStrategy()),
      turnSkills,
      query: "Where is my order?",
    });

    expect(selectorCalls).toEqual([1]);
    expect(dispatched).toEqual([RETRIEVAL_TURN_SKILL]);
    expect(presentation).toMatchObject({
      answer: "Grounded answer.",
      skillName: RETRIEVAL_TURN_SKILL,
      skillOutcome: "completed",
      skillStatus: "completed",
    });
    // The adapter surfaces the engine's turn result so the host can persist its trace.
    expect(result.outcomes[0]?.skillName).toBe(RETRIEVAL_TURN_SKILL);
    // A1 parity on the engine path: the dispatched outcome carries the prepared
    // neutral spine — the turn trace derived from the retrieval result, and the
    // staged context stamped with the dispatching skill name.
    expect(result.outcomes[0]?.trace.traceId).toBe("trace_1");
    expect(result.outcomes[0]?.stagedContext[0]).toMatchObject({
      kind: "retrieval",
      source: RETRIEVAL_TURN_SKILL,
    });
  });

  it("dispatches and renders whatever terminal skill is registered (no retrieval coupling)", async () => {
    // A non-retrieval skill proves the adapter is skill-agnostic: it dispatches and
    // renders purely from the injected skill, with no `retrieval` knowledge.
    const bookingSkill: TurnSkill = {
      definition: { name: "booking.create", outcomeKinds: ["booking"] },
      selects: () => true,
      dispatch: () => ({
        kind: "booking",
        skillName: "booking.create",
        outcome: { status: "completed", answer: "Booked." },
        stagedContext: [],
        steering: [],
        trace: { traceId: "t", startedAt: "2026-01-01T00:00:00.000Z", stages: [] },
      }),
      renderer: {
        supports: (outcome) => outcome.kind === "booking",
        render: async (outcome) => ({
          answer: outcome.outcome.answer ?? "",
          skillName: outcome.skillName,
          skillOutcome: outcome.outcome.status,
          skillStatus: outcome.outcome.status,
        }),
      },
    };

    const { engine, dispatched } = drivingEngine();
    const turnSkills = [bookingSkill];
    const { presentation } = await runPreparedChatTurnWithConversationEngine({
      engine,
      session: session(),
      chatAnswerPresenter,
      turnSkillSelector: new ChatTurnSkillSelector(turnSkills, new DefaultTurnSelectionStrategy()),
      turnSkills,
      query: "Book me a slot",
    });

    expect(dispatched).toEqual(["booking.create"]);
    expect(presentation).toMatchObject({ answer: "Booked.", skillName: "booking.create" });
  });

  it("runs directive matching and terminal skill selection inside the engine loop", async () => {
    const directive: Directive = {
      name: "brief",
      condition: { kind: "always" },
      action: "Keep it brief.",
      priority: 10,
    };
    const matched: Array<{ turnContext: Record<string, unknown>; directives: string[] }> = [];
    const directiveRuntime: RouteScopedDirectiveRuntime = {
      directivesFor() {
        return [directive];
      },
      matcher: {
        async match(input) {
          matched.push({
            turnContext: input.turnContext,
            directives: input.directives.map((candidate) => candidate.name),
          });
          return [{
            directive,
            selectionMode: "deterministic",
            selectionReason: "Directive condition is unconditional (always).",
          }];
        },
      },
      async resolveMatches(_input: DirectiveSteerInput, matches): Promise<DirectiveSteeringResult> {
        return {
          rules: matches.map((match) => ({
            action: match.directive.action,
            priority: match.directive.priority,
            source: "directive",
            lifespan: "response",
          })),
          matches,
          omissions: [],
        };
      },
      async matchCandidates(input: DirectiveSteerInput, directives) {
        matched.push({
          turnContext: input.turnContext ?? {},
          directives: directives.map((candidate) => candidate.name),
        });
        return directives.map((candidate) => ({
          directive: candidate,
          selectionMode: "deterministic" as const,
          selectionReason: "Directive condition is unconditional (always).",
        }));
      },
      async matchAndResolve(): Promise<DirectiveSteeringResult> {
        throw new Error("matchAndResolve not used in this test");
      },
      async matchAndResolveWithClassifications(): Promise<DirectiveSteeringResult> {
        throw new Error("matchAndResolveWithClassifications not used in this test");
      },
      async steer(): Promise<DirectiveSteeringResult> {
        throw new Error("steer should not pre-resolve chat engine directives");
      },
    };
    const selectedDirectiveSets: string[][] = [];
    const strategy: TurnSelectionStrategy = {
      select(input) {
        selectedDirectiveSets.push(input.directives.map((match) => match.directive.name));
        return ["retrieval"];
      },
    };
    const retrievalSkill: TurnSkill = {
      definition: { name: RETRIEVAL_TURN_SKILL, outcomeKinds: [RETRIEVAL_OUTCOME_KIND] },
      selects: () => true,
      dispatch: (s) => buildRetrievalTurnOutcome(s),
      renderer: {
        supports: (outcome) => outcome.kind === RETRIEVAL_OUTCOME_KIND,
        render: async (_outcome, ctx) => ({
          answer: ctx.session.directiveSteering?.rules.map((rule) => rule.action).join(" ") ?? "",
          skillName: RETRIEVAL_TURN_SKILL,
          skillOutcome: "completed",
          skillStatus: "completed",
        }),
      },
    };
    const prepared = session();
    prepared.directiveSteering = undefined;

    const { presentation, result } = await runPreparedChatTurnWithConversationEngine({
      engine: new DefaultConversationEngine(),
      session: prepared,
      chatAnswerPresenter,
      directiveRuntime,
      turnSkillSelector: new ChatTurnSkillSelector([retrievalSkill], strategy),
      turnSkills: [retrievalSkill],
      query: "Where is my order?",
    });

    expect(matched).toEqual([{
      turnContext: { query: "Where is my order?", route: "direct", visitorContext: { radioso_caller_kind: "human" } },
      directives: ["brief"],
    }]);
    expect(selectedDirectiveSets).toEqual([["brief"]]);
    expect(presentation.answer).toBe("Keep it brief.");
    expect(result.outcomes[0]?.steering).toEqual([
      expect.objectContaining({ action: "Keep it brief.", source: "directive", lifespan: "response" }),
    ]);
    expect(result.trace.stages.map((stage) => stage.kind)).toEqual([
      "message",
      "gather",
      "directive_match",
      "skill_selection",
      "skill_dispatch",
      "compose",
    ]);
  });

  // F1: `buildDirectiveTurnWiring`'s matcher adapter (`conversationProcessTurnInput.ts`)
  // overwrites `session.directiveSteering` as a side effect on every `match()` call. The
  // engine calls the matcher twice per retrieval turn with a coverage directive present
  // (legacy directives, then coverage directives), so the side effect from the second
  // call alone would leave the first call's rules unrendered. A REAL directive runtime
  // (not a hand-rolled matcher) exercises the actual two-call sequence.
  it("renders steering from both the legacy and the coverage matcher call (F1)", async () => {
    const warmthDirective: Directive = {
      name: "warmth",
      condition: { kind: "always" },
      action: "Be warm.",
      priority: 10,
    };
    const offerFormDirective: Directive = {
      name: "offer-form",
      condition: { kind: "always" },
      action: "Offer the form.",
      priority: 10,
      coverageCriteria: { coverage: ["unanswered"] },
    };
    const directiveRuntime = createRouteScopedDirectiveSteering({
      capabilityPolicy: new DefaultAllowCapabilityPolicy(),
      registrations: [
        { directive: warmthDirective },
        { directive: offerFormDirective },
      ],
    });
    const retrievalSkill: TurnSkill = {
      definition: { name: RETRIEVAL_TURN_SKILL, outcomeKinds: [RETRIEVAL_OUTCOME_KIND] },
      selects: () => true,
      dispatch: (s) => buildRetrievalTurnOutcome(s),
      renderer: {
        supports: (outcome) => outcome.kind === RETRIEVAL_OUTCOME_KIND,
        render: async (_outcome, ctx) => ({
          answer: (ctx.session.directiveSteering?.rules ?? []).map((rule) => rule.action).join(" "),
          skillName: RETRIEVAL_TURN_SKILL,
          skillOutcome: "completed",
          skillStatus: "completed",
        }),
      },
    };
    const prepared = session();
    prepared.turnRoute = "retrieval";

    const { presentation } = await runPreparedChatTurnWithConversationEngine({
      engine: new DefaultConversationEngine(),
      session: prepared,
      chatAnswerPresenter,
      directiveRuntime,
      turnInterpreter: { interpret: async () => ({ route: "retrieval" }) },
      turnSkillSelector: new ChatTurnSkillSelector([retrievalSkill], new DefaultTurnSelectionStrategy()),
      turnSkills: [retrievalSkill],
      query: "Where is my order?",
    });

    expect(presentation.answer).toBe("Be warm. Offer the form.");
  });

  // R1 (review round 2): the matcher adapter used to overwrite `session.directiveSteering`
  // on every `match()` call instead of resolving over the accumulated union. By the time
  // skill selection and the Activity trace read the session after a retrieval turn's
  // second (coverage) match call, only the coverage directive's match survived — a legacy
  // directive bound to a skill lost its vote in binding and disappeared from the trace,
  // even though `rules` (round 1's own fix) still rendered it. This proves the real fix:
  // `session.directiveSteering.matches` — read by directive-to-skill binding and the
  // Activity trace, independently of prompt rendering — carries every match from both
  // calls, and the legacy directive's binding still wins the turn.
  it("keeps every matched directive's binding and trace visibility across both matcher calls, and reports exactly one coverage reaction for the coverage-only directive (F1/R1, round 3 Q1)", async () => {
    const bookDemoDirective: Directive = {
      name: "book-demo",
      condition: { kind: "always" },
      action: "Offer to book a demo.",
      priority: 10,
      binding: { kind: "skill", skillName: "book-demo" },
    };
    const coverageDirective: Directive = {
      name: "offer-form",
      condition: { kind: "always" },
      action: "Offer the contact form.",
      priority: 5,
      coverageCriteria: { coverage: ["unanswered"] },
    };
    const directiveRuntime = createRouteScopedDirectiveSteering({
      capabilityPolicy: new DefaultAllowCapabilityPolicy(),
      registrations: [
        { directive: bookDemoDirective },
        { directive: coverageDirective },
      ],
    });
    const unansweredAssessment: AnswerCoverageAssessment = {
      availability: "assessed",
      coverage: "unanswered",
      reason: "insufficient_evidence",
      schemaVersion: 1,
      producer: "answer_head",
    };
    const bookDemoSkill: TurnSkill = {
      definition: { name: "book-demo", outcomeKinds: ["book_demo"] },
      // Never wins by default selection — only the directive binding should route here.
      selects: () => false,
      dispatch: () => ({
        kind: "book_demo",
        skillName: "book-demo",
        outcome: { status: "completed", answer: "Booked!" },
        stagedContext: [],
        steering: [],
        trace: { traceId: "t", startedAt: "2026-01-01T00:00:00.000Z", stages: [] },
      }),
      renderer: {
        supports: (outcome) => outcome.kind === "book_demo",
        // The bound skill still reports the turn's coverage verdict — coverage
        // reporting does not depend on which terminal skill won directive binding.
        render: async (outcome, ctx) => {
          await ctx.coverageVerdict?.report({ assessment: unansweredAssessment });
          return {
            answer: outcome.outcome.answer ?? "",
            skillName: outcome.skillName,
            skillOutcome: outcome.outcome.status,
            skillStatus: outcome.outcome.status,
          };
        },
      },
    };
    const retrievalSkill: TurnSkill = {
      definition: { name: RETRIEVAL_TURN_SKILL, outcomeKinds: [RETRIEVAL_OUTCOME_KIND] },
      selects: () => true,
      dispatch: (s) => buildRetrievalTurnOutcome(s),
      renderer: {
        supports: (outcome) => outcome.kind === RETRIEVAL_OUTCOME_KIND,
        render: async () => ({
          answer: "Grounded answer.",
          skillName: RETRIEVAL_TURN_SKILL,
          skillOutcome: "completed",
          skillStatus: "completed",
        }),
      },
    };
    const prepared = session();
    prepared.turnRoute = "retrieval";
    const recordedReactions: Array<{ reactionKey: string; decision: string; reasonCode: string }> = [];
    const coverageReactionRecorder: ConversationCoverageReactionRecorder = {
      async record({ reactions }) {
        recordedReactions.push(...reactions);
      },
    };

    const { presentation, result } = await runPreparedChatTurnWithConversationEngine({
      engine: new DefaultConversationEngine(),
      session: prepared,
      chatAnswerPresenter,
      directiveRuntime,
      turnInterpreter: { interpret: async () => ({ route: "retrieval" }) },
      turnSkillSelector: new ChatTurnSkillSelector(
        [retrievalSkill, bookDemoSkill],
        new DefaultTurnSelectionStrategy(),
      ),
      turnSkills: [retrievalSkill, bookDemoSkill],
      query: "Where is my order?",
      coverageReactionRecorder,
    });

    expect(presentation).toMatchObject({ answer: "Booked!", skillName: "book-demo" });

    const matchedNames = (prepared.directiveSteering?.matches ?? [])
      .map((match) => match.directive.name)
      .sort();
    expect(matchedNames).toEqual(["book-demo", "offer-form"]);

    const trace: ActivityTrace = { traceId: "t", startedAt: "2026-01-01T00:00:00.000Z", stages: [], links: [] };
    const traced = appendDirectiveSteeringStage(trace, prepared.directiveSteering);
    const tracedMatches = traced.stages[0]?.outputs?.matched as Array<{ name: string }> | undefined;
    expect(tracedMatches?.map((entry) => entry.name).sort()).toEqual(["book-demo", "offer-form"]);

    // Round 3, Q1: the coverage matcher call's `match()` return used to be the
    // whole turn's accumulated union, so the legacy `book-demo` directive (never
    // coverage-gated) rode along into `coverageDirectiveMatches` and got recorded
    // as a second, spurious "applied" coverage reaction.
    const directiveReactions = recordedReactions.filter((reaction) => reaction.reactionKey.startsWith("directive:"));
    expect(directiveReactions).toHaveLength(1);
    expect(directiveReactions[0]).toMatchObject({ decision: "applied", reasonCode: "coverage_criteria_applied" });

    const coverageStage = result.trace.stages.find((stage) => stage.kind === "coverage_directive_match");
    expect(coverageStage?.outputs).toMatchObject({ matchCount: 1, candidateCount: 1 });
  });

  // R2 (review round 2): round 1's `syncSessionSteeringForRender` patch copied the
  // engine's own `turn.steering` — ids only where a directive carries an authored
  // `directive.id` — over the host's `d1..dN` ids that `DirectiveSteeringService.
  // resolveMatches` assigns once per turn across every rendered rule, including a
  // built-in directive with no authored id. Removing that patch and fixing the
  // match-call accumulation at the adapter (R1) restores those ids with no separate
  // mechanism: the answer prompt and `attestableSteering` must agree on them.
  it("assigns d-prefixed host ids across both matcher calls, including a built-in directive (R2)", async () => {
    const builtInDirective: Directive = {
      name: "builtin-persona",
      condition: { kind: "always" },
      action: "Speak as the brand voice.",
      priority: 20,
    };
    const coverageDirective: Directive = {
      name: "offer-form",
      condition: { kind: "always" },
      action: "Offer the contact form.",
      priority: 10,
      coverageCriteria: { coverage: ["unanswered"] },
    };
    const directiveRuntime = createRouteScopedDirectiveSteering({
      capabilityPolicy: new DefaultAllowCapabilityPolicy(),
      registrations: [
        { directive: builtInDirective },
        { directive: coverageDirective },
      ],
    });
    const retrievalSkill: TurnSkill = {
      definition: { name: RETRIEVAL_TURN_SKILL, outcomeKinds: [RETRIEVAL_OUTCOME_KIND] },
      selects: () => true,
      dispatch: (s) => buildRetrievalTurnOutcome(s),
      renderer: {
        supports: (outcome) => outcome.kind === RETRIEVAL_OUTCOME_KIND,
        render: async (_outcome, ctx) => {
          const composed = composeGroundedAnswerSystemPrompt({
            baseSystemPrompt: "Base instructions.",
            suggestedQuestionsEnabled: false,
            suggestedQuestionsCount: 0,
            hasRetrievedContexts: true,
            conversationIntentSnapshot: { recentTurns: [] },
            steering: ctx.session.directiveSteering?.rules ?? [],
          });
          return {
            answer: composed.systemPrompt,
            skillName: RETRIEVAL_TURN_SKILL,
            skillOutcome: "completed",
            skillStatus: "completed",
          };
        },
      },
    };
    const prepared = session();
    prepared.turnRoute = "retrieval";

    const { presentation } = await runPreparedChatTurnWithConversationEngine({
      engine: new DefaultConversationEngine(),
      session: prepared,
      chatAnswerPresenter,
      directiveRuntime,
      turnInterpreter: { interpret: async () => ({ route: "retrieval" }) },
      turnSkillSelector: new ChatTurnSkillSelector([retrievalSkill], new DefaultTurnSelectionStrategy()),
      turnSkills: [retrievalSkill],
      query: "Where is my order?",
    });

    const rules = prepared.directiveSteering?.rules ?? [];
    expect(rules.map((rule) => ({ directiveName: rule.directiveName, id: rule.id }))).toEqual([
      { directiveName: "builtin-persona", id: "d1" },
      { directiveName: "offer-form", id: "d2" },
    ]);
    // Every rendered rule carries its host id in the prompt, including the
    // id-less "built-in" directive — not just directives with an authored id.
    expect(presentation.answer).toContain("[d1] Speak as the brand voice.");
    expect(presentation.answer).toContain("[d2] Only when your coverage verdict is one of");

    const attestable = attestableSteering(rules);
    expect(attestable.map((rule) => rule.id)).toEqual(["d1", "d2"]);
  });

  // Round 3, Q2: ranked activation returning an offer/clarification makes
  // `routineActivation.ts`'s `clarify` branch call `buildResolvedSteering`
  // again with the same turn-scoped matcher — a third `match()` call sharing
  // the adapter's per-turn accumulator with the legacy and coverage calls
  // above it. Before the fix, every directive got re-pushed and re-resolved,
  // so the session's final steering doubled every directive.
  it("dedupes the accumulated match candidates so a coverage-offer clarification does not double every directive (round 3, Q2)", async () => {
    const warmthDirective: Directive = {
      name: "warmth",
      condition: { kind: "always" },
      action: "Be warm.",
      priority: 10,
    };
    const offerFormDirective: Directive = {
      name: "offer-form",
      condition: { kind: "always" },
      action: "Offer the form.",
      priority: 5,
      coverageCriteria: { coverage: ["unanswered"] },
    };
    const directiveRuntime = createRouteScopedDirectiveSteering({
      capabilityPolicy: new DefaultAllowCapabilityPolicy(),
      registrations: [
        { directive: warmthDirective },
        { directive: offerFormDirective },
      ],
    });
    const unansweredAssessment: AnswerCoverageAssessment = {
      availability: "assessed",
      coverage: "unanswered",
      reason: "insufficient_evidence",
      schemaVersion: 1,
      producer: "answer_head",
    };
    const retrievalSkill: TurnSkill = {
      definition: { name: RETRIEVAL_TURN_SKILL, outcomeKinds: [RETRIEVAL_OUTCOME_KIND] },
      selects: () => true,
      dispatch: (s) => buildRetrievalTurnOutcome(s),
      renderer: {
        supports: (outcome) => outcome.kind === RETRIEVAL_OUTCOME_KIND,
        render: async (_outcome, ctx) => {
          const decision = await ctx.coverageVerdict?.report({ assessment: unansweredAssessment });
          return decision?.decision === "yield_turn"
            ? { answer: "", yielded: true, skillName: RETRIEVAL_TURN_SKILL, skillOutcome: "yielded", skillStatus: "completed" }
            : { answer: "Grounded answer.", skillName: RETRIEVAL_TURN_SKILL, skillOutcome: "completed", skillStatus: "completed" };
        },
      },
    };
    const prepared = session();
    prepared.turnRoute = "retrieval";

    const { presentation } = await runPreparedChatTurnWithConversationEngine({
      engine: new DefaultConversationEngine(),
      session: prepared,
      chatAnswerPresenter: {
        presentRoutineAnswer: (answer: string) => ({ answer, skillName: "routine", skillOutcome: "completed", skillStatus: "completed" }),
      } as unknown as ChatAnswerPresenter,
      directiveRuntime,
      turnInterpreter: { interpret: async () => ({ route: "retrieval" }) },
      turnSkillSelector: new ChatTurnSkillSelector([retrievalSkill], new DefaultTurnSelectionStrategy()),
      turnSkills: [retrievalSkill],
      query: "Where is my order?",
      // Ranked activation offers a routine rather than activating one — the
      // `clarify` branch that re-invokes the turn's directive matcher.
      coverageRoutineActivator: {
        evaluateCandidates: () => [],
        activate: async () => ({
          kind: "clarify" as const,
          candidates: [{ id: "support", label: "Talk to support", confidence: 1, payload: { routineId: "support" } }],
        }),
      },
      routineStore: {
        loadActive: async () => null,
        loadCompleted: async () => [],
        save: async () => {},
        clear: async () => {},
      },
      routineRunner: { resume: async () => ({ response: { answer: "unused" }, nextState: null }) },
      clarifier: {
        phraseQuestion: async () => "Would you like to talk to support?",
        mapReply: async () => ({ kind: "unrelated" }),
      },
      clarificationStore: { loadPending: async () => null, save: async () => {}, clear: async () => {} },
    });

    expect(presentation.answer).toBe("Would you like to talk to support?");

    const rules = prepared.directiveSteering?.rules ?? [];
    expect(rules.map((rule) => rule.directiveName).sort()).toEqual(["offer-form", "warmth"]);
    const matches = prepared.directiveSteering?.matches ?? [];
    expect(matches.map((match) => match.directive.name).sort()).toEqual(["offer-form", "warmth"]);
  });

  it("lets the engine drive streamed turn selection and emits any final unstreamed remainder", async () => {
    const inference = new ModelInferencePipelineService({
      metadata: { capability: "chat", provider: "openai", model: "gpt-stream" },
      complete: vi.fn(),
      stream: vi.fn(() => ({
        textStream: (async function* () {
          yield "Hello";
        })(),
        usage: Promise.resolve({
          inputTokens: 6,
          outputTokens: 2,
          totalTokens: 8,
          quality: "actual" as const,
        }),
      })),
    });
    const streamingSkill: TurnSkill = {
      definition: { name: "booking.create", outcomeKinds: ["booking"] },
      selects: () => true,
      dispatch: () => ({
        kind: "booking",
        skillName: "booking.create",
        outcome: { status: "completed", answer: "Hello world." },
        stagedContext: [],
        steering: [],
        trace: { traceId: "t", startedAt: "2026-01-01T00:00:00.000Z", stages: [] },
      }),
      renderer: {
        supports: (outcome) => outcome.kind === "booking",
        render: async (outcome) => ({
          answer: outcome.outcome.answer ?? "",
          skillName: outcome.skillName,
          skillOutcome: outcome.outcome.status,
          skillStatus: outcome.outcome.status,
        }),
        async *stream() {
          const answer = inference.stream({
            operation: {
              workspaceId: "workspace_1",
              surface: "assistant",
              operation: "direct_answer",
              attemptKey: "private-answer-attempt",
            },
            prompt: "private prompt",
          });
          for await (const chunk of answer.textStream) {
            yield chunk;
          }
          return {
            finalPresentation: {
              answer: "Hello world.",
              skillName: "booking.create",
              skillOutcome: "completed",
              skillStatus: "completed",
            },
            suggestions: { mode: "presentation" },
            hasStreamedAnswer: true,
            streamedAnswer: "Hello",
          };
        },
      },
    };
    const engine = new DefaultConversationEngine();
    const events: RunPreparedChatTurnStreamWithConversationEngineEvent[] = [];
    const collector = createModelCallTraceCollector();

    for await (const event of runAsyncIterableWithModelCallTrace(collector, () =>
      runPreparedChatTurnStreamWithConversationEngine({
        engine,
        session: session(),
      chatAnswerPresenter,
        turnSkillSelector: new ChatTurnSkillSelector([streamingSkill], new DefaultTurnSelectionStrategy()),
        turnSkills: [streamingSkill],
        query: "Book me a slot",
      }))) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "status", stage: "composing" },
      { type: "chunk", text: "Hello", deliveryMode: "live", route: "direct" },
      { type: "chunk", text: " world.", deliveryMode: "live", route: "direct" },
      {
        type: "final",
        presentation: expect.objectContaining({ answer: "Hello world.", skillName: "booking.create" }),
        suggestions: { mode: "presentation" },
        result: expect.objectContaining({
          response: expect.objectContaining({ answer: "Hello world." }),
        }),
        engineTrace: expect.objectContaining({
          stages: expect.arrayContaining([
            expect.objectContaining({ kind: "skill_selection" }),
            expect.objectContaining({ kind: "skill_dispatch" }),
            expect.objectContaining({ kind: "compose" }),
          ]),
        }),
      },
    ]);
    const final = events.find((event) => event.type === "final");
    if (!final || final.type !== "final") {
      throw new Error("expected final event");
    }
    const envelope = buildTurnTraceEnvelope({ spine: final.engineTrace, modelCallTrace: collector });
    expect(envelope.summary).toMatchObject({ totalLlmCalls: 1, droppedCallCount: 0 });
    expect(envelope.spine.stages.find((stage) => stage.kind === "model_calls")?.outputs?.modelCalls)
      .toEqual([expect.objectContaining({
        id: "model_call_1",
        operation: "direct_answer",
        model: "gpt-stream",
        stageId: "compose",
      })]);
  });
});
