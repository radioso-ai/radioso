import type { ReplyDraft } from "@radioso/conversation-contract";

import type { MessageRecord, MessageRepositoryPort } from "../../../db/repositories/messageRepository.js";
import { GROUNDING_VERDICTS, type GroundingDiagnosticSnapshot } from "../../../shared/domain/groundingDiagnostic.js";
import type { SuppressedSkillEffect } from "../../../shared/domain/suppressedSkillEffect.js";
import type { DirectiveStateStore } from "../../directives/public.js";
import type { ChatAnswerCoverageAssessment } from "../contracts/answerCoverage.js";
import type { ChatReviewResult, ReviewTurnFactsSource } from "../types/chatReview.js";
import { SKILL_TURN_OUTCOME, type AssistantTurnOutcome } from "./assistantTurnOutcomeTypes.js";
import {
  applyDeferredDirectiveTransition,
  type DeferredDirectiveTransition,
} from "./directives/deferredDirectiveStateStore.js";

/** The reply row a turn builds before deciding how it completes. */
type UnpersistedReply = Parameters<MessageRepositoryPort["create"]>[0];

/** A review turn's correlation: the customer message it answered and the turn itself. */
export interface ReviewTurnCorrelation {
  requestMessageId: string;
  turnId: string;
}

/**
 * The draft is what publishing the turn's reply writes: the reply row the turn would have written,
 * without the row's identity — its text, and everything else the published message carries — and
 * the conversation state the turn deferred until its reply is published. Its directive firing
 * memory advance rides in the presentation, which every holder stores and hands back unread, under
 * a key no message column reads.
 */
export const reviewedTurnDraft = (
  reply: UnpersistedReply,
  directiveTransition: DeferredDirectiveTransition | null,
): ReplyDraft => ({
  text: reply.content,
  presentation: Object.fromEntries(Object.entries({
    skillName: reply.skillName,
    skillOutcome: reply.skillOutcome,
    skillStatus: reply.skillStatus,
    totalLatencyMs: reply.totalLatencyMs,
    grounding: reply.grounding,
    metadata: reply.metadata,
    directiveTransition: directiveTransition ?? undefined,
  }).filter(([, value]) => value !== undefined)),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * The directive firing memory advance a draft's turn deferred, read back from a draft that has
 * been stored since; null when it deferred none, or what is stored no longer reads as one.
 */
export const deferredDirectiveTransitionOf = (draft: ReplyDraft): DeferredDirectiveTransition | null => {
  const stored = draft.presentation.directiveTransition;
  if (!isRecord(stored)) return null;
  const { fromTurnSeq, firedNames } = stored;
  return typeof fromTurnSeq === "number"
    && Number.isSafeInteger(fromTurnSeq)
    && fromTurnSeq >= 0
    && Array.isArray(firedNames)
    && firedNames.every((name): name is string => typeof name === "string")
    ? { fromTurnSeq, firedNames }
    : null;
};

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
  draft: ReplyDraft;
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

/** The stores publishing a reviewed draft writes through, bound to the publishing transaction. */
interface ReviewedDraftPublicationStores {
  messages: Pick<MessageRepositoryPort, "create">;
  directiveStates: DirectiveStateStore;
}

/**
 * Publishes reviewed drafts unchanged as the agent's message: writes the reply row the review turn
 * would have written, and applies the directive firing memory advance the turn deferred, in the
 * caller's transaction. Only an unchanged publication runs it — an operator's unchanged release or
 * an automatic send materializing — so a draft that was discarded, superseded, or sent as a
 * teammate's edit never advances what the agent's own reply would have. Applying is idempotent:
 * a second publication of the same draft writes no second advance.
 */
export const reviewedDraftWriter = (stores: ReviewedDraftPublicationStores) => ({
  async writeAgentMessage(input: {
    workspaceId: string;
    conversationId: string;
    draft: ReplyDraft;
  }): Promise<MessageRecord> {
    const message = await stores.messages.create(publishedDraftReply(input));
    const transition = deferredDirectiveTransitionOf(input.draft);
    if (transition) {
      await applyDeferredDirectiveTransition(stores.directiveStates, input.conversationId, transition);
    }
    return message;
  },
});

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

// A reply with no text, or the stand-in written when the model could not be reached, is
// nothing a person could review.
const isReviewable = (draft: ReplyDraft, facts: ReviewTurnFactsSource): boolean =>
  draft.text.trim().length > 0 && facts.skillOutcome !== SKILL_TURN_OUTCOME.RETRIEVAL_UNAVAILABLE.outcome;

/** Maps a completed review turn to its result: a draft when it wrote a reviewable reply, otherwise no draft. */
export const chatReviewResult = (input: {
  conversationId: string;
  ownershipVersion: number;
  draft: ReplyDraft;
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
