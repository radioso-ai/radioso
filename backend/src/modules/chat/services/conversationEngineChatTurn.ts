import type {
  ConversationEngine,
  ProcessTurnResult,
  RenderableTurn,
  SkillDefinition,
} from "@radioso/conversation-contract";

import type { ChatPresentedAnswer } from "./chatAnswerPresenter.js";
import type { PreparedSession } from "./chatSessionPreparer.js";
import { createChatProcessTurnInput } from "./conversationProcessTurnInput.js";
import {
  RETRIEVAL_OUTCOME_KIND,
  RETRIEVAL_TURN_SKILL,
  buildRetrievalTurnOutcome,
  type TurnOutcomeRendererRegistry,
} from "./turnOutcome.js";
import type { TurnSelectionStrategy } from "./turnSelectionStrategy.js";

export interface RunPreparedChatTurnWithConversationEngineInput {
  engine: ConversationEngine;
  session: PreparedSession;
  selectionStrategy: TurnSelectionStrategy;
  turnRenderers: TurnOutcomeRendererRegistry;
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

// The single answer skill this slice dispatches. Intake candidates are handled
// upstream by ChatService before the engine runs, and retrieval-vs-direct is
// resolved during session prep, so the terminal answer candidate maps here.
const retrievalAnswerSkill: SkillDefinition = {
  name: RETRIEVAL_TURN_SKILL,
  outcomeKinds: [RETRIEVAL_OUTCOME_KIND],
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
 * TurnSelectionStrategy) and dispatches (building the retrieval outcome from the
 * prepared session) the answer skill itself, rather than receiving an
 * already-built outcome. Persistence, billing, streaming, and HTTP stay outside
 * this adapter; ChatService still owns session prep and the intake path.
 */
export const runPreparedChatTurnWithConversationEngine = async (
  input: RunPreparedChatTurnWithConversationEngineInput,
): Promise<RunPreparedChatTurnWithConversationEngineResult> => {
  let rendered: ChatPresentedAnswer | null = null;
  const processTurnInput = createChatProcessTurnInput({
    session: input.session,
    skills: [retrievalAnswerSkill],
    selector: {
      async select() {
        // Consult the per-agent strategy so the selection seam is honored. Intake
        // candidates were already resolved by ChatService; the terminal answer
        // candidate is the sole registered answer skill in this slice.
        const candidates = input.selectionStrategy.select({
          session: input.session,
          directives: input.session.directiveSteering?.matches ?? [],
        });
        return {
          selected: [{
            skillName: RETRIEVAL_TURN_SKILL,
            reason: "turn_selection_strategy",
          }],
          reason: candidates.length > 0 ? `candidates:${candidates.join(",")}` : "turn_selection_strategy",
        };
      },
    },
    dispatcher: {
      async dispatch() {
        return buildRetrievalTurnOutcome(input.session);
      },
    },
    composer: {
      async compose({ outcomes }) {
        const outcome = outcomes[0];
        if (!outcome) {
          throw new Error("conversation_engine_dispatched_no_outcome");
        }
        rendered = await input.turnRenderers.resolve(outcome).render(outcome, {
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
