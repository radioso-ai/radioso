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
  /** Rolling conversation summary (#866); absent/empty renders nothing. */
  conversationSummary?: string;
  /** Behavioral steering matched for this turn (authored Directives + skill guidance). */
  steering?: SteeringRule[];
  /** Labels/descriptions for retrieval-sense alternatives to offer after the grounded answer. */
  retrievalSenseOfferAlternatives?: Array<{ label: string; description?: string }>;
}

/**
 * Role-separated prompt parts for one grounded-answer generation. The composer
 * owns static/operator instruction assembly; its caller assigns the dynamic
 * conversation data to the gateway's user prompt.
 */
export interface GroundedAnswerPromptResult {
  systemPrompt: string;
  /**
   * Conversation-derived material for the user/data role. It must never be
   * concatenated into systemPrompt because visitor turns and rolling summaries
   * are not operator-authored instructions.
   */
  conversationContextPrompt: string;
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
): GroundedAnswerPromptResult => {
  const suggestionsExpected =
    input.suggestedQuestionsEnabled &&
    input.suggestedQuestionsCount > 0 &&
    input.hasRetrievedContexts;

  const base = input.baseSystemPrompt ?? "";
  const steeringBlock = renderSteeringBlock(input.steering ?? [], { includeRuleIds: true });
  const withSteering = steeringBlock ? joinBlocks(base, steeringBlock) : base;
  const alternatives = formatOfferAlternatives(input.retrievalSenseOfferAlternatives);
  const grounded = alternatives
    ? joinBlocks(withSteering, renderPromptTemplate("chat/retrieval-sense-offer.md", {}))
    : withSteering;

  const envelopeBlock = renderPromptTemplate("chat/answer-envelope.md", {});
  const withEnvelope = joinBlocks(grounded, envelopeBlock);
  if (!suggestionsExpected) {
    return {
      systemPrompt: withEnvelope,
      conversationContextPrompt: input.conversationSummary?.trim() || alternatives
        ? renderConversationContextPrompt(input)
        : "",
      suggestionsExpected: false,
    };
  }

  const suggestionBlock = renderPromptTemplate("chat/answer-suggestions.md", {
    max_suggestions: String(input.suggestedQuestionsCount),
  });

  return {
    systemPrompt: joinBlocks(withEnvelope, suggestionBlock),
    conversationContextPrompt: renderConversationContextPrompt(input),
    suggestionsExpected: true,
  };
};

const renderConversationContextPrompt = (input: GroundedAnswerSystemPromptInput): string =>
  renderPromptTemplate("chat/grounded-answer-conversation-context.md", {
    conversation_summary: input.conversationSummary?.trim() || "None",
    recent_turns_json: formatConversationIntentSnapshot(input.conversationIntentSnapshot),
    active_subject: input.conversationIntentSnapshot.activeSubject ?? "None",
    active_goal: input.conversationIntentSnapshot.activeGoal ?? "None",
    retrieval_sense_offer_alternatives: formatOfferAlternatives(input.retrievalSenseOfferAlternatives) || "None",
  });
