import type {
  ConversationEngine,
  RenderableTurn,
  SkillDefinition,
} from "@radioso/conversation-contract";

import type { ChatPresentedAnswer } from "./chatAnswerPresenter.js";
import type { PreparedSession } from "./chatSessionPreparer.js";
import { createChatProcessTurnInput } from "./conversationProcessTurnInput.js";
import type { TurnOutcome, TurnOutcomeRendererRegistry } from "./turnOutcome.js";

export interface RunPreparedChatTurnWithConversationEngineInput {
  engine: ConversationEngine;
  session: PreparedSession;
  turnOutcome: TurnOutcome;
  turnRenderers: TurnOutcomeRendererRegistry;
  query: string;
  userExpectedLocale?: string | null;
  accountId?: string;
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

const skillForOutcome = (outcome: TurnOutcome): SkillDefinition => ({
  name: outcome.skillName,
  outcomeKinds: [outcome.kind],
});

/**
 * Runs a prepared Radioso chat turn through a conversation-engine implementation
 * while preserving Radioso-owned rendering. Persistence, billing, streaming, and
 * HTTP stay outside this adapter.
 */
export const runPreparedChatTurnWithConversationEngine = async (
  input: RunPreparedChatTurnWithConversationEngineInput,
): Promise<ChatPresentedAnswer> => {
  let rendered: ChatPresentedAnswer | null = null;
  const processTurnInput = createChatProcessTurnInput({
    session: input.session,
    skills: [skillForOutcome(input.turnOutcome)],
    dispatcher: {
      async dispatch() {
        return input.turnOutcome;
      },
    },
    selector: {
      async select() {
        return {
          selected: [{
            skillName: input.turnOutcome.skillName,
            reason: "prepared_chat_turn_outcome",
          }],
          reason: "prepared_chat_turn_outcome",
        };
      },
    },
    composer: {
      async compose({ outcomes }) {
        const outcome = outcomes[0] ?? input.turnOutcome;
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

  await input.engine.processTurn(processTurnInput);
  if (!rendered) {
    throw new Error("conversation_engine_rendered_no_chat_presentation");
  }
  return rendered;
};
