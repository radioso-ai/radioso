import { renderPromptTemplate } from "../../../shared/infra/prompts/promptLoader.js";
import {
  formatConversationIntentSnapshot,
  type ConversationIntentSnapshot,
} from "./conversationIntentSnapshot.js";

export interface GroundedAnswerSystemPromptInput {
  baseSystemPrompt: string;
  suggestedQuestionsEnabled: boolean;
  suggestedQuestionsCount: number;
  hasRetrievedContexts: boolean;
  conversationIntentSnapshot: ConversationIntentSnapshot;
}

export interface GroundedAnswerSystemPromptResult {
  systemPrompt: string;
  envelopeExpected: boolean;
}

export const composeGroundedAnswerSystemPrompt = (
  input: GroundedAnswerSystemPromptInput,
): GroundedAnswerSystemPromptResult => {
  const envelopeExpected =
    input.suggestedQuestionsEnabled &&
    input.suggestedQuestionsCount > 0 &&
    input.hasRetrievedContexts;

  const base = input.baseSystemPrompt ?? "";
  if (!envelopeExpected) {
    return { systemPrompt: base, envelopeExpected: false };
  }

  const envelopeBlock = renderPromptTemplate("chat/answer-envelope.md", {
    max_suggestions: String(input.suggestedQuestionsCount),
    recent_turns_json: formatConversationIntentSnapshot(input.conversationIntentSnapshot),
    active_subject: input.conversationIntentSnapshot.activeSubject ?? "None",
    active_goal: input.conversationIntentSnapshot.activeGoal ?? "None",
  });

  return {
    systemPrompt: base ? `${base}\n\n${envelopeBlock}` : envelopeBlock,
    envelopeExpected: true,
  };
};
