import { renderPromptTemplate } from "../../../shared/infra/prompts/promptLoader.js";
import type { SteeringRule } from "../../../shared/domain/steeringRule.js";
import {
  formatConversationIntentSnapshot,
  type ConversationIntentSnapshot,
} from "./conversationIntentSnapshot.js";
import { renderSteeringBlock } from "../../../shared/infra/prompts/steeringPromptRenderer.js";
import { GENERATION_SURFACE } from "../../../shared/domain/generationSurface.js";
import { steeringForSurface } from "../../../shared/domain/steeringRule.js";

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

/**
 * The rules the answer prompt renders with bracketed ids, and therefore the only ones
 * a model can attest to. The suggestion block renders its rules without ids, and
 * renders nothing at all when suggestions are off or no context was retrieved, so a
 * rule addressed only to that generator is never attestable. Callers that build an
 * answer side channel narrow through this rather than restating the rule, so the
 * attested set cannot drift from the rendered one.
 */
export const attestableSteering = (steering: SteeringRule[] = []): SteeringRule[] =>
  steeringForSurface(steering, GENERATION_SURFACE.ANSWER);

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

  // Rules addressed to the follow-up question generator render inside its own block,
  // where its standing rules are, rather than in the answer steering above it.
  const suggestionSteering = renderSteeringBlock(input.steering ?? [], {
    surface: GENERATION_SURFACE.SUGGESTED_QUESTIONS,
  });
  const suggestionBlock = renderPromptTemplate("chat/answer-suggestions.md", {
    max_suggestions: String(input.suggestedQuestionsCount),
    steering_block: suggestionSteering ? `${suggestionSteering}\n\n` : "",
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
