import type { ReplyDraft } from "@radioso/conversation-contract";

import type { SuppressedSkillEffect } from "../../../shared/domain/suppressedSkillEffect.js";
import type { ChatAnswerCoverageAssessment } from "../contracts/answerCoverage.js";
import type { AssistantTurnOutcome } from "../services/assistantTurnOutcomeTypes.js";

/**
 * A review turn: the agent answers a customer message that is already recorded, and the
 * reply comes back as a draft for a person or a channel policy to publish. Nothing a
 * customer sees is written.
 */
export interface ChatReviewInput {
  workspaceId: string;
  agentId: string;
  conversationId: string;
  /** The recorded customer message the turn answers; the turn records no message of its own. */
  existingUserMessageId: string;
  /** The most earlier messages the turn reads as conversation history. */
  historyWindow: { maxMessages: number };
}

/** The turn's own record of how it went, for a channel to decide what to do with the draft. */
export interface ReviewTurnFactsSource {
  answerOutcome: AssistantTurnOutcome | null;
  answerCoverage: ChatAnswerCoverageAssessment | null;
  skillOutcome: string | null;
  /** The hand-off the turn asked for; reported only, so ownership is unchanged. */
  ownershipHandoffSignal: { reason: string } | null;
  /** The skill effects the turn would have run, in the order they were suppressed. */
  suppressedEffects: readonly SuppressedSkillEffect[];
  citationCount: number;
}

/**
 * How a review turn ended. `ownershipVersion` is the ownership the turn read, so a caller
 * can tell whether a person took the conversation over while it ran.
 */
export type ChatReviewResult =
  | { kind: "draft"; conversationId: string; ownershipVersion: number; draft: ReplyDraft; facts: ReviewTurnFactsSource }
  /** The turn produced no usable reply: no text, or the model could not be reached. */
  | { kind: "no_draft"; conversationId: string; ownershipVersion: number; facts: ReviewTurnFactsSource }
  /** A person owns the conversation, so no turn ran. */
  | { kind: "human_owned"; conversationId: string; ownershipVersion: number };
