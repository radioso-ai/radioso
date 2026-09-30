import { renderPromptTemplate } from "../../../shared/infra/prompts/promptLoader.js";
import type { RoutinePendingStep, SteeringRule } from "../../../shared/domain/steeringRule.js";
import {
  formatConversationIntentSnapshot,
  type ConversationIntentSnapshot,
} from "./conversationIntentSnapshot.js";
import { appendRoutineLeadBack, renderSteeringBlock } from "../../../shared/infra/prompts/steeringPromptRenderer.js";
import { GENERATION_SURFACE } from "../../../shared/domain/generationSurface.js";
import { steeringForSurface } from "../../../shared/domain/steeringRule.js";
import { createReusableInputBoundary } from "../../../shared/infra/llm/inputTokenCaching.js";
import type { ReusableInputBoundary } from "../../../shared/infra/llm/providerTypes.js";

interface GroundedAnswerSystemPromptInput {
  baseSystemPrompt: string;
  suggestedQuestionsEnabled: boolean;
  suggestedQuestionsCount: number;
  hasRetrievedContexts: boolean;
  conversationIntentSnapshot: ConversationIntentSnapshot;
  /** Rolling conversation summary (#866); absent/empty renders nothing. */
  conversationSummary?: string;
  /** Behavioral steering matched for this turn (authored Directives + skill guidance). */
  steering?: SteeringRule[];
  /** The step a routine that yielded this turn still waits on; the answer closes by pointing back to it. */
  pendingRoutineStep?: RoutinePendingStep;
  /** Labels/descriptions for retrieval-sense alternatives to offer after the grounded answer. */
  retrievalSenseOfferAlternatives?: Array<{ label: string; description?: string }>;
}

/**
 * Role-separated prompt parts for one grounded-answer generation. The composer
 * owns static/operator instruction assembly; its caller assigns the dynamic
 * conversation data to the gateway's user prompt.
 */
interface GroundedAnswerPromptResult {
  systemPrompt: string;
  reusableInputBoundary?: ReusableInputBoundary;
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
  // The model commits its own coverage verdict as the envelope's head rather than
  // receiving one (#1260), so both blocks render on every grounded call.
  const coverageHeadBlock = renderPromptTemplate("chat/answer-coverage-head.md", {});
  const coverageGuidance = renderPromptTemplate("chat/answer-coverage-response-guidance.md", {});
  const withEnvelope = joinBlocks(
    joinBlocks(joinBlocks(grounded, coverageHeadBlock), coverageGuidance),
    envelopeBlock,
  );
  // A parked routine's lead-back shapes the answer's last sentence, so it closes the prompt.
  const withLeadBack = (prompt: string): string =>
    appendRoutineLeadBack(prompt, input.steering ?? [], input.pendingRoutineStep);
  if (!suggestionsExpected) {
    return resultWithReusablePrefix(base, withLeadBack(withEnvelope), {
      conversationContextPrompt: input.conversationSummary?.trim() || alternatives
        ? renderConversationContextPrompt(input)
        : "",
      suggestionsExpected: false,
    });
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

  return resultWithReusablePrefix(base, withLeadBack(joinBlocks(withEnvelope, suggestionBlock)), {
    conversationContextPrompt: renderConversationContextPrompt(input),
    suggestionsExpected: true,
  });
};

const resultWithReusablePrefix = (
  stableSystemPrefix: string,
  systemPrompt: string,
  dynamic: Omit<GroundedAnswerPromptResult, "systemPrompt" | "reusableInputBoundary">,
): GroundedAnswerPromptResult => ({
  systemPrompt,
  ...dynamic,
  ...(() => {
    const reusableInputBoundary = createReusableInputBoundary({
    stableSystemPrefix,
    dynamicSystemSuffix: systemPrompt.slice(stableSystemPrefix.length),
    });
    return reusableInputBoundary ? { reusableInputBoundary } : {};
  })(),
});

const renderConversationContextPrompt = (input: GroundedAnswerSystemPromptInput): string =>
  renderPromptTemplate("chat/grounded-answer-conversation-context.md", {
    conversation_summary: input.conversationSummary?.trim() || "None",
    recent_turns_json: formatConversationIntentSnapshot(input.conversationIntentSnapshot),
    active_subject: input.conversationIntentSnapshot.activeSubject ?? "None",
    active_goal: input.conversationIntentSnapshot.activeGoal ?? "None",
    retrieval_sense_offer_alternatives: formatOfferAlternatives(input.retrievalSenseOfferAlternatives) || "None",
  });
