import { renderPromptTemplate } from "../../../shared/infra/prompts/promptLoader.js";
import { orderSteeringRules, type SteeringRule } from "../../../shared/domain/steeringRule.js";
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
  /** Behavioral steering matched for this turn (authored Directives + skill guidance). */
  steering?: SteeringRule[];
}

export interface GroundedAnswerSystemPromptResult {
  systemPrompt: string;
  envelopeExpected: boolean;
}

const joinBlocks = (head: string, block: string): string => (head ? `${head}\n\n${block}` : block);

const renderSteeringBlock = (steering: SteeringRule[]): string => {
  if (steering.length === 0) {
    return "";
  }
  const lines = orderSteeringRules(steering)
    .map((rule) => (rule.condition ? `- ${rule.action} (when: ${rule.condition})` : `- ${rule.action}`))
    .join("\n");
  return renderPromptTemplate("chat/steering.md", { steering_rules: lines });
};

export const composeGroundedAnswerSystemPrompt = (
  input: GroundedAnswerSystemPromptInput,
): GroundedAnswerSystemPromptResult => {
  const envelopeExpected =
    input.suggestedQuestionsEnabled &&
    input.suggestedQuestionsCount > 0 &&
    input.hasRetrievedContexts;

  const base = input.baseSystemPrompt ?? "";
  const steeringBlock = renderSteeringBlock(input.steering ?? []);
  const grounded = steeringBlock ? joinBlocks(base, steeringBlock) : base;

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
