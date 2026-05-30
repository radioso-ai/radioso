import type {
  ConversationEngine,
  ProcessTurnResult,
  RenderableTurn,
} from "@radioso/conversation-contract";

import type { ChatPresentedAnswer } from "./chatAnswerPresenter.js";
import type { PreparedSession } from "./chatSessionPreparer.js";
import { createChatProcessTurnInput } from "./conversationProcessTurnInput.js";
import { buildTurnRendererRegistry, type TurnSkill } from "./turnOutcome.js";
import type { TurnSelectionStrategy } from "./turnSelectionStrategy.js";

export interface RunPreparedChatTurnWithConversationEngineInput {
  engine: ConversationEngine;
  session: PreparedSession;
  selectionStrategy: TurnSelectionStrategy;
  /** The registered turn skills the engine selects, dispatches, and renders. */
  turnSkills: TurnSkill[];
  query: string;
  userExpectedLocale?: string | null;
  accountId?: string;
}

export interface RunPreparedChatTurnWithConversationEngineResult {
  /** The Radioso-rendered presentation the host persists and returns. */
  presentation: ChatPresentedAnswer;
  /** The engine's turn result — its selection/dispatch trace and events. */
  result: ProcessTurnResult;
}

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
  const skillsByName = new Map(input.turnSkills.map((skill) => [skill.definition.name, skill]));
  const renderers = buildTurnRendererRegistry(input.turnSkills);
  // The terminal answer skill for this prepared turn. Intake candidates were
  // already resolved by ChatService before the engine runs, and retrieval-vs-direct
  // is resolved during session prep, so the terminal candidate is whichever
  // registered skill claims this turn.
  const terminal = input.turnSkills.find((skill) => skill.selects(input.session)) ?? input.turnSkills[0];
  if (!terminal) {
    throw new Error("conversation_engine_no_turn_skill_registered");
  }

  const processTurnInput = createChatProcessTurnInput({
    session: input.session,
    skills: input.turnSkills.map((skill) => skill.definition),
    selector: {
      async select() {
        // Consult the per-agent strategy so the selection seam is honored, then
        // select the terminal skill that claims this turn.
        const candidates = input.selectionStrategy.select({
          session: input.session,
          directives: input.session.directiveSteering?.matches ?? [],
        });
        return {
          selected: [{
            skillName: terminal.definition.name,
            reason: "turn_selection_strategy",
          }],
          reason: candidates.length > 0 ? `candidates:${candidates.join(",")}` : "turn_selection_strategy",
        };
      },
    },
    dispatcher: {
      async dispatch({ skill }) {
        const turnSkill = skillsByName.get(skill.name);
        if (!turnSkill) {
          throw new Error(`conversation_engine_no_turn_skill_for_${skill.name}`);
        }
        return turnSkill.dispatch(input.session);
      },
    },
    composer: {
      async compose({ outcomes }) {
        const outcome = outcomes[0];
        if (!outcome) {
          throw new Error("conversation_engine_dispatched_no_outcome");
        }
        rendered = await renderers.resolve(outcome).render(outcome, {
          session: input.session,
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
