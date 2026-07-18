import type {
  ConversationEngine,
  ConversationClarificationStore,
  ConversationClarifier,
  Directive,
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
import {
  buildTurnRendererRegistry,
  getUnstreamedFinalAnswerRemainder,
  type TurnSkill,
  type TurnStreamResult,
  type TurnStreamSuggestions,
} from "./turnOutcome.js";
import type { ChatTurnSkillSelector } from "./turnSkillSelector.js";

export interface RunPreparedChatTurnWithConversationEngineInput {
  engine: ConversationEngine;
  session: PreparedSession;
  /** The shared seam that resolves which terminal skill claims this turn. */
  turnSkillSelector: ChatTurnSkillSelector;
  /** The registered turn skills the engine selects, dispatches, and renders. */
  turnSkills: TurnSkill[];
  /** Route-scoped directive catalog + matcher used by the engine's directive port. */
  directiveRuntime?: RouteScopedDirectiveRuntime;
  query: string;
  userExpectedLocale?: string | null;
  accountId?: string;
  turnInterpreter?: ConversationTurnInterpreter;
  retrievalWork?: ConversationRetrievalWorkPort;
  getSession?: () => PreparedSession;
  beforeRender?: () => Promise<void>;
}

export interface RunPreparedChatTurnWithConversationEngineResult {
  /** The Radioso-rendered presentation the host persists and returns. */
  presentation: ChatPresentedAnswer;
  /** The engine's turn result — its selection/dispatch trace and events. */
  result: ProcessTurnResult;
}

export type RunPreparedChatTurnStreamWithConversationEngineEvent =
  | { type: "chunk"; text: string }
  | {
      type: "final";
      presentation: ChatPresentedAnswer;
      suggestions: TurnStreamSuggestions;
      result: ProcessTurnResult;
      engineTrace: ConversationTrace;
    };

const toRenderableTurn = (presentation: ChatPresentedAnswer): RenderableTurn => ({
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

  const processTurnInput = createChatProcessTurnStreamInput({
    session: input.session,
    getSession: readSession,
    accountId: input.accountId,
    skills: input.turnSkills.map((skill) => skill.definition),
    directiveRuntime: input.directiveRuntime,
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
      async compose() {
        throw new Error("conversation_engine_stream_used_non_streaming_compose");
      },
      async *stream({ outcomes }) {
        const outcome = outcomes[0];
        if (!outcome) {
          throw new Error("conversation_engine_dispatched_no_outcome");
        }
        await input.beforeRender?.();
        const turnSkill = skillsByName.get(outcome.skillName);
        if (!turnSkill?.streamRender) {
          const finalPresentation = await renderers.resolve(outcome).render(outcome, {
            session: readSession(),
            query: input.query,
            userExpectedLocale: input.userExpectedLocale,
            accountId: input.accountId,
          });
          streamState.result = {
            finalPresentation,
            suggestions: { mode: "presentation" },
            hasStreamedAnswer: false,
            streamedAnswer: "",
          };
          if (finalPresentation.answer) {
            yield { type: "delta", text: finalPresentation.answer };
          }
          yield {
            type: "final",
            response: toRenderableTurn(finalPresentation),
          };
          return;
        }
        const answerStream = turnSkill.streamRender({
          session: readSession(),
          query: input.query,
          userExpectedLocale: input.userExpectedLocale,
          accountId: input.accountId,
        });
        let streamStep = await answerStream.next();
        while (!streamStep.done) {
          yield { type: "delta", text: streamStep.value };
          streamStep = await answerStream.next();
        }
        streamState.result = streamStep.value;
        const remainingAnswer = getUnstreamedFinalAnswerRemainder(streamState.result);
        if (remainingAnswer) {
          yield { type: "delta", text: remainingAnswer };
        }
        yield {
          type: "final",
          response: toRenderableTurn(streamState.result.finalPresentation),
        };
      },
    },
  });

  const engineEvents = input.engine.processTurnStream(processTurnInput)[Symbol.asyncIterator]();
  while (true) {
    const step = await engineEvents.next();
    if (step.done) {
      break;
    }
    const event = step.value;
    if (event.type === "delta") {
      yield { type: "chunk", text: event.text };
      continue;
    }
    const streamResult = streamState.result;
    if (!streamResult) {
      throw new Error("conversation_engine_stream_missing_chat_result");
    }
    const result = event.result;
    yield {
      type: "final",
      presentation: streamResult.finalPresentation,
      suggestions: streamResult.suggestions,
      result,
      engineTrace: result.trace,
    };
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
  routineStore: ConversationRoutineStore;
  routineRunner: ConversationRoutineRunner;
  routineActivator: ConversationRoutineActivator;
  routineSlotCorrection?: ConversationRoutineSlotCorrection;
  routineReentryGate?: ConversationRoutineReentryGate;
  clarifier?: ConversationClarifier;
  clarificationStore?: ConversationClarificationStore;
  loopGuardCandidateIds?: string[];
  suppressNewClarification?: boolean;
  presentRoutineReply: (response: RenderableTurn) => ChatPresentedAnswer;
}): Promise<RunPreparedChatTurnWithConversationEngineResult | null> => {
  const result = await input.engine.attemptRoutine(
    createAttemptRoutineInput({
      session: input.session,
      accountId: input.accountId,
      directives: input.directives,
      directiveRuntime: input.directiveRuntime,
      routineStore: input.routineStore,
      routineRunner: input.routineRunner,
      routineActivator: input.routineActivator,
      routineSlotCorrection: input.routineSlotCorrection,
      routineReentryGate: input.routineReentryGate,
      clarifier: input.clarifier,
      clarificationStore: input.clarificationStore,
      loopGuardCandidateIds: input.loopGuardCandidateIds,
      suppressNewClarification: input.suppressNewClarification,
    }),
  );
  if (!result) {
    return null;
  }
  return { presentation: input.presentRoutineReply(result.response), result };
};
