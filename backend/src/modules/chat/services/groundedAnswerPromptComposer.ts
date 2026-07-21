import { renderPromptTemplate } from "../../../shared/infra/prompts/promptLoader.js";
import type { SteeringRule } from "../../../shared/domain/steeringRule.js";
import {
  formatConversationIntentSnapshot,
  type ConversationIntentSnapshot,
} from "./conversationIntentSnapshot.js";
import { renderSteeringBlock } from "../../../shared/infra/prompts/steeringPromptRenderer.js";
import { renderConversationSummarySection } from "./summary/conversationSummarySection.js";

export interface GroundedAnswerSystemPromptInput {
  baseSystemPrompt: string;
  suggestedQuestionsEnabled: boolean;
  suggestedQuestionsCount: number;
  hasRetrievedContexts: boolean;
  conversationIntentSnapshot: ConversationIntentSnapshot;
  /** Rolling conversation summary (#866); absent/empty renders nothing. */
  conversationSummary?: string;
  /** Behavioral steering matched for this turn (authored Directives + skill guidance). */
  steering?: SteeringRule[];
  /** Labels/descriptions for retrieval-sense alternatives to offer after the grounded answer. */
  retrievalSenseOfferAlternatives?: Array<{ label: string; description?: string }>;
}

export interface GroundedAnswerSystemPromptResult {
  systemPrompt: string;
  suggestionsExpected: boolean;
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
  const suggestionsExpected =
    input.suggestedQuestionsEnabled &&
    input.suggestedQuestionsCount > 0 &&
    input.hasRetrievedContexts;

  const base = input.baseSystemPrompt ?? "";
  const steeringBlock = renderSteeringBlock(input.steering ?? []);
  const withSteering = steeringBlock ? joinBlocks(base, steeringBlock) : base;
  const summarySection = renderConversationSummarySection(input.conversationSummary);
  const withSummary = summarySection ? joinBlocks(withSteering, summarySection) : withSteering;
  const alternatives = formatOfferAlternatives(input.retrievalSenseOfferAlternatives);
  const grounded = alternatives
    ? joinBlocks(withSummary, renderPromptTemplate("chat/retrieval-sense-offer.md", { alternatives }))
    : withSummary;

  const envelopeBlock = renderPromptTemplate("chat/answer-envelope.md", {});
  const withEnvelope = joinBlocks(grounded, envelopeBlock);
  if (!suggestionsExpected) {
    return { systemPrompt: withEnvelope, suggestionsExpected: false };
  }

  const suggestionBlock = renderPromptTemplate("chat/answer-suggestions.md", {
    max_suggestions: String(input.suggestedQuestionsCount),
    recent_turns_json: formatConversationIntentSnapshot(input.conversationIntentSnapshot),
    active_subject: input.conversationIntentSnapshot.activeSubject ?? "None",
    active_goal: input.conversationIntentSnapshot.activeGoal ?? "None",
  });

  return {
    systemPrompt: joinBlocks(withEnvelope, suggestionBlock),
    suggestionsExpected: true,
  };
};
