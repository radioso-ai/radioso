import type {
  ConversationEngine,
  ConversationProgressPhase,
  ConversationProgressPort,
  ConversationClarificationStore,
  ConversationClarifier,
  Directive,
  DirectiveAdherenceEntry,
  ConversationRoutineActivator,
  ConversationRoutineReentryGate,
  ConversationRoutineSlotCorrection,
  ConversationRoutineRunner,
  ConversationRoutineStore,
  ConversationRetrievalWorkPort,
  ConversationTrace,
  ConversationTurnInterpreter,
  ProcessTurnResult,
  RenderableTurn,
} from "@radioso/conversation-contract";

import type { ChatPresentedAnswer } from "./chatAnswerPresenter.js";
import type { PreparedSession } from "./chatSessionPreparer.js";
import {
  createAttemptRoutineInput,
  createChatProcessTurnInput,
  createChatProcessTurnStreamInput,
} from "./conversationProcessTurnInput.js";
import type { RouteScopedDirectiveRuntime } from "./routeScopedDirectiveSteering.js";
import type { DirectiveStateStore } from "../../directives/public.js";
import {
  buildTurnRendererRegistry,
  committedAnswerChunks,
  getUnstreamedFinalAnswerRemainder,
  type TurnSkill,
  type TurnStreamResult,
  type TurnStreamSuggestions,
} from "./turnOutcome.js";
import type { ChatTurnSkillSelector } from "./turnSkillSelector.js";
import type { ChatStatusStage } from "../contracts/streamEvents.js";

export interface RunPreparedChatTurnWithConversationEngineInput {
  engine: ConversationEngine;
  session: PreparedSession;
  /** The shared seam that resolves which terminal skill claims this turn. */
  turnSkillSelector: ChatTurnSkillSelector;
  /** The registered turn skills the engine selects, dispatches, and renders. */
  turnSkills: TurnSkill[];
  /** Route-scoped directive catalog + matcher used by the engine's directive port. */
  directiveRuntime?: RouteScopedDirectiveRuntime;
  /** Durable per-conversation directive firing memory for lifecycle suppression (#865). */
  directiveStateStore?: DirectiveStateStore;
  query: string;
  userExpectedLocale?: string | null;
  accountId?: string;
  turnInterpreter?: ConversationTurnInterpreter;
  retrievalWork?: ConversationRetrievalWorkPort;
  getSession?: () => PreparedSession;
  beforeRender?: () => Promise<void>;
  signal?: AbortSignal;
}

export interface RunPreparedChatTurnWithConversationEngineResult {
  /** The Radioso-rendered presentation the host persists and returns. */
  presentation: ChatPresentedAnswer;
  /** The engine's turn result — its selection/dispatch trace and events. */
  result: ProcessTurnResult;
}

export type RunPreparedChatTurnStreamWithConversationEngineEvent =
  | { type: "status"; stage: ChatStatusStage }
  | {
      type: "chunk";
      text: string;
      deliveryMode: "live" | "committed" | "bounded_decline";
      route: "direct" | "retrieval" | "other";
    }
  | {
      type: "final";
      presentation: ChatPresentedAnswer;
      suggestions: TurnStreamSuggestions;
      result: ProcessTurnResult;
      engineTrace: ConversationTrace;
    };

export const toChatStatusStage = (phase: ConversationProgressPhase): ChatStatusStage => {
  switch (phase) {
    case "preparing":
    case "interpreting":
      return "interpreting";
    case "retrieving":
      return "searching";
    case "selecting":
    case "dispatching":
    case "composing":
    case "routine":
      return "composing";
  }
};

type QueuedEngineEvent =
  | RunPreparedChatTurnStreamWithConversationEngineEvent
  | { type: "error"; error: unknown };

const toRenderableTurn = (
  presentation: ChatPresentedAnswer,
  traceMetrics?: Record<string, number>,
): RenderableTurn => ({
  answer: presentation.answer,
  citations: presentation.citations,
  suggestions: presentation.suggestions,
  metadata: {
    skillName: presentation.skillName,
    skillOutcome: presentation.skillOutcome,
    skillStatus: presentation.skillStatus,
    answerOutcome: presentation.answerOutcome,
    answerSegments: presentation.answerSegments,
    planningCitations: presentation.planningCitations,
    grounding: presentation.grounding,
    ...(presentation.metadata?.directiveAdherence
      ? { directiveAdherence: presentation.metadata.directiveAdherence as DirectiveAdherenceEntry[] }
      : {}),
    ...(traceMetrics ? { traceMetrics } : {}),
  },
});

/**
 * Runs a prepared Radioso chat turn through a conversation-engine implementation
 * while preserving Radioso-owned rendering. The engine selects (via the existing
 * TurnSelectionStrategy) and dispatches a terminal answer skill from the injected
 * `turnSkills`, then renders the outcome through that skill's renderer.
 *
 * This adapter is skill-agnostic: it references no specific skill, only the
 * skill-shaped input it is given. Concrete skills (e.g. retrieval) are registered
 * by the host. Persistence, billing, streaming, and HTTP stay outside it;
 * ChatService still owns session prep and the intake path.
 */
export const runPreparedChatTurnWithConversationEngine = async (
  input: RunPreparedChatTurnWithConversationEngineInput,
): Promise<RunPreparedChatTurnWithConversationEngineResult> => {
  let rendered: ChatPresentedAnswer | null = null;
  const readSession = input.getSession ?? (() => input.session);
  const skillsByName = new Map(input.turnSkills.map((skill) => [skill.definition.name, skill]));
  const renderers = buildTurnRendererRegistry(input.turnSkills);
  const processTurnInput = createChatProcessTurnInput({
    session: input.session,
    getSession: readSession,
    accountId: input.accountId,
    skills: input.turnSkills.map((skill) => skill.definition),
    directiveRuntime: input.directiveRuntime,
    directiveStateStore: input.directiveStateStore,
    turnInterpreter: input.turnInterpreter,
    retrievalWork: input.retrievalWork,
    selector: {
      async select() {
        const { decision } = input.turnSkillSelector.select(readSession());
        return decision;
      },
    },
    dispatcher: {
      async dispatch({ skill }) {
        const turnSkill = skillsByName.get(skill.name);
        if (!turnSkill) {
          throw new Error(`conversation_engine_no_turn_skill_for_${skill.name}`);
        }
        return turnSkill.dispatch(readSession());
      },
    },
    composer: {
      async compose({ outcomes }) {
        const outcome = outcomes[0];
        if (!outcome) {
          throw new Error("conversation_engine_dispatched_no_outcome");
        }
        await input.beforeRender?.();
        rendered = await renderers.resolve(outcome).render(outcome, {
          session: readSession(),
          query: input.query,
          userExpectedLocale: input.userExpectedLocale,
          accountId: input.accountId,
        });
        return toRenderableTurn(rendered);
      },
    },
  });

  const result = await input.engine.processTurn(processTurnInput);
  if (!rendered) {
    throw new Error("conversation_engine_rendered_no_chat_presentation");
  }
  return { presentation: rendered, result };
};

export const runPreparedChatTurnStreamWithConversationEngine = async function* (
  input: RunPreparedChatTurnWithConversationEngineInput,
): AsyncIterable<RunPreparedChatTurnStreamWithConversationEngineEvent> {
  const readSession = input.getSession ?? (() => input.session);
  const skillsByName = new Map(input.turnSkills.map((skill) => [skill.definition.name, skill]));
  const renderers = buildTurnRendererRegistry(input.turnSkills);
  const streamState: { result?: TurnStreamResult } = {};
  const queued: QueuedEngineEvent[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  let pumpDone = false;
  let lastStatus: ChatStatusStage | undefined;
  const enqueue = (event: QueuedEngineEvent): void => {
    if (closed) {
      return;
    }
    queued.push(event);
    wake?.();
    wake = undefined;
  };

  const processTurnInput = createChatProcessTurnStreamInput({
    session: input.session,
    getSession: readSession,
    accountId: input.accountId,
    skills: input.turnSkills.map((skill) => skill.definition),
    directiveRuntime: input.directiveRuntime,
    directiveStateStore: input.directiveStateStore,
    turnInterpreter: input.turnInterpreter,
    retrievalWork: input.retrievalWork,
    progress: {
      report({ phase }) {
        if (input.signal?.aborted) {
          return;
        }
        const stage = toChatStatusStage(phase);
        if (stage === lastStatus) {
          return;
        }
        lastStatus = stage;
        enqueue({ type: "status", stage });
      },
    },
    selector: {
      async select() {
        const { decision } = input.turnSkillSelector.select(readSession());
        return decision;
      },
    },
    dispatcher: {
      async dispatch({ skill }) {
        const turnSkill = skillsByName.get(skill.name);
        if (!turnSkill) {
          throw new Error(`conversation_engine_no_turn_skill_for_${skill.name}`);
        }
        return turnSkill.dispatch(readSession());
      },
    },
    composer: {
      async compose() {
        throw new Error("conversation_engine_stream_used_non_streaming_compose");
      },
      streamCommitted(response) {
        return committedAnswerChunks(response.answer);
      },
      async *stream({ outcomes }) {
        const outcome = outcomes[0];
        if (!outcome) {
          throw new Error("conversation_engine_dispatched_no_outcome");
        }
        await input.beforeRender?.();
        const answerStream = renderers.stream(outcome, {
          session: readSession(),
          query: input.query,
          userExpectedLocale: input.userExpectedLocale,
          accountId: input.accountId,
          signal: input.signal,
        });
        const hasLiveRenderer = Boolean(renderers.resolve(outcome).stream);
        let streamStep = await answerStream.next();
        while (!streamStep.done) {
          yield {
            type: "delta",
            text: streamStep.value,
            metadata: { deliveryMode: hasLiveRenderer ? "live" : "committed" },
          };
          streamStep = await answerStream.next();
        }
        streamState.result = streamStep.value;
        const remainingAnswer = getUnstreamedFinalAnswerRemainder(streamState.result);
        if (remainingAnswer) {
          yield {
            type: "delta",
            text: remainingAnswer,
            metadata: {
              deliveryMode: streamState.result.deliveryMode
                ?? (streamState.result.hasStreamedAnswer ? "live" : "committed"),
            },
          };
        }
        yield {
          type: "final",
          response: toRenderableTurn(streamState.result.finalPresentation, streamState.result.traceMetrics),
        };
      },
    },
  });

  const engineEvents = input.engine.processTurnStream(processTurnInput)[Symbol.asyncIterator]();
  const closeForAbort = () => {
    if (closed) {
      return;
    }
    queued.length = 0;
    closed = true;
    queued.push({ type: "error", error: input.signal?.reason ?? new Error("chat_turn_aborted") });
    wake?.();
    wake = undefined;
  };
  if (input.signal?.aborted) {
    closeForAbort();
  } else {
    input.signal?.addEventListener("abort", closeForAbort, { once: true });
  }

  void (async () => {
    try {
      while (!closed) {
        const step = await engineEvents.next();
        if (step.done) {
          break;
        }
        const event = step.value;
        if (event.type === "delta") {
          const deliveryMode = event.metadata?.deliveryMode;
          const turnRoute = readSession().turnRoute;
          enqueue({
            type: "chunk",
            text: event.text,
            deliveryMode: deliveryMode === "live" || deliveryMode === "bounded_decline"
              ? deliveryMode
              : "committed",
            route: turnRoute === "direct" || turnRoute === "retrieval" ? turnRoute : "other",
          });
          continue;
        }
        const streamResult = streamState.result;
        if (!streamResult) {
          throw new Error("conversation_engine_stream_missing_chat_result");
        }
        const result = event.result;
        enqueue({
          type: "final",
          presentation: streamResult.finalPresentation,
          suggestions: streamResult.suggestions,
          result,
          engineTrace: result.trace,
        });
      }
    } catch (error) {
      enqueue({ type: "error", error });
    } finally {
      // The pump is the sole owner of engine iterator shutdown. This cannot
      // preempt an already-running stage beyond the engine's cooperative signal
      // checks and provider aborts; that pre-existing zombie-stage window is #868.
      try {
        await engineEvents.return?.();
      } catch {
        // Iterator cleanup is best-effort and must never become an unhandled
        // rejection after the consumer has already received cancellation.
      }
      pumpDone = true;
      wake?.();
      wake = undefined;
    }
  })();

  try {
    while ((!closed && !pumpDone) || queued.length > 0) {
      if (queued.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        continue;
      }
      const event = queued.shift()!;
      if (event.type === "error") {
        throw event.error;
      }
      yield event;
    }
  } finally {
    input.signal?.removeEventListener("abort", closeForAbort);
    if (!closed) {
      queued.length = 0;
      closed = true;
      wake?.();
      wake = undefined;
    }
  }
};

/**
 * Attempts a routine for this turn *before* grounding — the routine is a multi-turn
 * skill selected ahead of retrieval. Returns the routine's rendered reply when it
 * claims the turn, or null when no routine is active/activates or it yields (off-topic),
 * so ChatService can fall through to grounding. Routine resume/activation never runs
 * selection, dispatch, or composition, so this passes only the narrow routine input —
 * no stub selector/dispatcher/composer.
 */
export const attemptRoutineTurnWithConversationEngine = async (input: {
  engine: ConversationEngine;
  session: PreparedSession;
  accountId?: string;
  directives?: Directive[];
  directiveRuntime?: RouteScopedDirectiveRuntime;
  directiveStateStore?: DirectiveStateStore;
  routineStore: ConversationRoutineStore;
  routineRunner: ConversationRoutineRunner;
  routineActivator: ConversationRoutineActivator;
  routineSlotCorrection?: ConversationRoutineSlotCorrection;
  routineReentryGate?: ConversationRoutineReentryGate;
  clarifier?: ConversationClarifier;
  clarificationStore?: ConversationClarificationStore;
  loopGuardCandidateIds?: string[];
  suppressNewClarification?: boolean;
  progress?: ConversationProgressPort;
  presentRoutineReply: (response: RenderableTurn) => ChatPresentedAnswer;
}): Promise<RunPreparedChatTurnWithConversationEngineResult | null> => {
  const result = await input.engine.attemptRoutine(
    createAttemptRoutineInput({
      session: input.session,
      accountId: input.accountId,
      directives: input.directives,
      directiveRuntime: input.directiveRuntime,
      directiveStateStore: input.directiveStateStore,
      routineStore: input.routineStore,
      routineRunner: input.routineRunner,
      routineActivator: input.routineActivator,
      routineSlotCorrection: input.routineSlotCorrection,
      routineReentryGate: input.routineReentryGate,
      clarifier: input.clarifier,
      clarificationStore: input.clarificationStore,
      loopGuardCandidateIds: input.loopGuardCandidateIds,
      suppressNewClarification: input.suppressNewClarification,
      progress: input.progress,
    }),
  );
  if (!result) {
    return null;
  }
  return { presentation: input.presentRoutineReply(result.response), result };
};
