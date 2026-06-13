import { renderPromptTemplate } from "../../../shared/infra/prompts/promptLoader.js";
import type { SteeringRule } from "../../../shared/domain/steeringRule.js";
import {
  formatConversationIntentSnapshot,
  type ConversationIntentSnapshot,
} from "./conversationIntentSnapshot.js";
import { renderSteeringBlock } from "../../../shared/infra/prompts/steeringPromptRenderer.js";

export interface GroundedAnswerSystemPromptInput {
  baseSystemPrompt: string;
  suggestedQuestionsEnabled: boolean;
  suggestedQuestionsCount: number;
  hasRetrievedContexts: boolean;
  conversationIntentSnapshot: ConversationIntentSnapshot;
  /** Behavioral steering matched for this turn (authored Directives + skill guidance). */
  steering?: SteeringRule[];
  /** Labels/descriptions for retrieval-sense alternatives to offer after the grounded answer. */
  retrievalSenseOfferAlternatives?: Array<{ label: string; description?: string }>;
}

export interface GroundedAnswerSystemPromptResult {
  systemPrompt: string;
  envelopeExpected: boolean;
}

const joinBlocks = (head: string, block: string): string => (head ? `${head}\n\n${block}` : block);

const formatOfferAlternatives = (
  alternatives: Array<{ label: string; description?: string }> = [],
): string =>
  alternatives
    .map((alternative, index) => {
      const label = alternative.label.trim();
      const description = alternative.description?.trim();
      return description
        ? `${index + 1}. ${label}: ${description}`
        : `${index + 1}. ${label}`;
    })
    .join("\n");

export const composeGroundedAnswerSystemPrompt = (
  input: GroundedAnswerSystemPromptInput,
): GroundedAnswerSystemPromptResult => {
  const envelopeExpected =
    input.suggestedQuestionsEnabled &&
    input.suggestedQuestionsCount > 0 &&
    input.hasRetrievedContexts;

  const base = input.baseSystemPrompt ?? "";
  const steeringBlock = renderSteeringBlock(input.steering ?? []);
  const withSteering = steeringBlock ? joinBlocks(base, steeringBlock) : base;
  const alternatives = formatOfferAlternatives(input.retrievalSenseOfferAlternatives);
  const grounded = alternatives
    ? joinBlocks(withSteering, renderPromptTemplate("chat/retrieval-sense-offer.md", { alternatives }))
    : withSteering;

  if (!envelopeExpected) {
    return { systemPrompt: grounded, envelopeExpected: false };
  }

  const envelopeBlock = renderPromptTemplate("chat/answer-envelope.md", {
    max_suggestions: String(input.suggestedQuestionsCount),
    recent_turns_json: formatConversationIntentSnapshot(input.conversationIntentSnapshot),
    active_subject: input.conversationIntentSnapshot.activeSubject ?? "None",
    active_goal: input.conversationIntentSnapshot.activeGoal ?? "None",
  });

  return {
    systemPrompt: joinBlocks(grounded, envelopeBlock),
    envelopeExpected: true,
  };
};
