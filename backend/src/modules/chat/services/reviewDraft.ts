import type { MessageRepositoryPort } from "../../../db/repositories/messageRepository.js";
import { GROUNDING_VERDICTS, type GroundingDiagnosticSnapshot } from "../../../shared/domain/groundingDiagnostic.js";
import type { SuppressedSkillEffect } from "../../../shared/domain/suppressedSkillEffect.js";
import type { AuditEventInput } from "../../audit/contracts/index.js";
import type { ChatAnswerCoverageAssessment } from "../contracts/answerCoverage.js";
import type { ChatReviewResult, ReviewedTurnDraft, ReviewTurnFactsSource } from "../types/chatReview.js";
import { SKILL_TURN_OUTCOME, type AssistantTurnOutcome } from "./assistantTurnOutcomeTypes.js";

/** The reply row a turn builds before deciding how it completes. */
type UnpersistedReply = Parameters<MessageRepositoryPort["create"]>[0];

/** A review turn's correlation: the customer message it answered and the turn itself. */
export interface ReviewTurnCorrelation {
  requestMessageId: string;
  turnId: string;
}

/**
 * The draft is the reply row the turn would have written, without the row's identity:
 * its text, and everything else the published message carries.
 */
export const reviewedTurnDraft = (reply: UnpersistedReply): ReviewedTurnDraft => ({
  text: reply.content,
  presentation: Object.fromEntries(Object.entries({
    skillName: reply.skillName,
    skillOutcome: reply.skillOutcome,
    skillStatus: reply.skillStatus,
    totalLatencyMs: reply.totalLatencyMs,
    grounding: reply.grounding,
    metadata: reply.metadata,
  }).filter(([, value]) => value !== undefined)),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const stringField = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const numberField = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

const groundingField = (value: unknown): GroundingDiagnosticSnapshot | undefined => {
  if (!isRecord(value)) return undefined;
  const verdict = GROUNDING_VERDICTS.find((known) => known === value.verdict);
  const claimCount = numberField(value.claimCount);
  const sourcedClaimCount = numberField(value.sourcedClaimCount);
  const unsourcedClaimCount = numberField(value.unsourcedClaimCount);
  const invalidSourceCount = numberField(value.invalidSourceCount);
  return verdict !== undefined
    && claimCount !== undefined
    && sourcedClaimCount !== undefined
    && unsourcedClaimCount !== undefined
    && invalidSourceCount !== undefined
    ? { verdict, claimCount, sourcedClaimCount, unsourcedClaimCount, invalidSourceCount }
    : undefined;
};

/**
 * The agent's reply row a published draft becomes: the row its review turn would have written,
 * rebuilt from the draft's text and the presentation {@link reviewedTurnDraft} kept of it. The
 * presentation has been stored since, so each field is narrowed back, and one that no longer reads
 * as its column is left unset rather than written wrong.
 */
export const publishedDraftReply = (input: {
  workspaceId: string;
  conversationId: string;
  draft: ReviewedTurnDraft;
}): UnpersistedReply => {
  const { presentation } = input.draft;
  return {
    conversationId: input.conversationId,
    workspaceId: input.workspaceId,
    role: "assistant",
    content: input.draft.text,
    skillName: stringField(presentation.skillName),
    skillOutcome: stringField(presentation.skillOutcome),
    skillStatus: stringField(presentation.skillStatus),
    totalLatencyMs: numberField(presentation.totalLatencyMs),
    grounding: groundingField(presentation.grounding),
    metadata: isRecord(presentation.metadata) ? presentation.metadata : undefined,
  };
};

export const reviewTurnFacts = (input: {
  answerOutcome: AssistantTurnOutcome | undefined;
  answerCoverage: ChatAnswerCoverageAssessment | undefined;
  skillOutcome: string;
  ownershipHandoff: { reason: string } | null | undefined;
  suppressedEffects: readonly SuppressedSkillEffect[] | undefined;
  citationCount: number;
}): ReviewTurnFactsSource => ({
  answerOutcome: input.answerOutcome ?? null,
  answerCoverage: input.answerCoverage ?? null,
  skillOutcome: input.skillOutcome,
  ownershipHandoffSignal: input.ownershipHandoff ? { reason: input.ownershipHandoff.reason } : null,
  suppressedEffects: [...(input.suppressedEffects ?? [])],
  citationCount: input.citationCount,
});

/**
 * A review turn's audit event correlates on the request it answered and the turn. It
 * names no assistant message, because none was written.
 */
export const reviewedTurnAuditEvent = (
  event: AuditEventInput,
  correlation: ReviewTurnCorrelation,
): AuditEventInput => {
  const { assistantMessageId: _unwritten, ...metadata } = event.metadata ?? {};
  return {
    ...event,
    metadata: { ...metadata, requestMessageId: correlation.requestMessageId, turnId: correlation.turnId },
  };
};

// A reply with no text, or the stand-in written when the model could not be reached, is
// nothing a person could review.
const isReviewable = (draft: ReviewedTurnDraft, facts: ReviewTurnFactsSource): boolean =>
  draft.text.trim().length > 0 && facts.skillOutcome !== SKILL_TURN_OUTCOME.RETRIEVAL_UNAVAILABLE.outcome;

/** Maps a completed review turn to its result: a draft when it wrote a reviewable reply, otherwise no draft. */
export const chatReviewResult = (input: {
  conversationId: string;
  ownershipVersion: number;
  draft: ReviewedTurnDraft;
  facts: ReviewTurnFactsSource;
}): ChatReviewResult =>
  isReviewable(input.draft, input.facts)
    ? {
        kind: "draft",
        conversationId: input.conversationId,
        ownershipVersion: input.ownershipVersion,
        draft: input.draft,
        facts: input.facts,
      }
    : {
        kind: "no_draft",
        conversationId: input.conversationId,
        ownershipVersion: input.ownershipVersion,
        facts: input.facts,
      };
