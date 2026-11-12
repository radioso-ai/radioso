import type { PreparedSession } from "./chatSessionPreparer.js";
import { admitsPageEvidence } from "./pageRead/pageReadSessionOutcome.js";
import type { GroundedAnswerEnvelope } from "./groundedAnswerEnvelope.js";
import type { ComposedDecline } from "./fallbackReplyComposer.js";
import type { TurnDeclineReason } from "./assistantTurnOutcomeTypes.js";
import {
  declineReasonForCommittedOutcome,
  type CommittedDeclineOutcome,
  type GroundingSummary,
} from "./groundingAssertions.js";
import { headOfCompletedEnvelope } from "./groundedAnswerHeadReader.js";
import type { RoutinePendingStep } from "../../../shared/domain/steeringRule.js";

/**
 * Enforces the v2 grounding protocol at delivery time. A valid answer envelope must carry at
 * least one in-range sourced assertion; lexical similarity is not evidence and cannot turn an
 * anchor-free draft into a grounded answer. Admitted page evidence is a source of its own.
 */
export const shouldSuppressUnsupportedDraft = (
  session: PreparedSession,
  envelope: Pick<GroundedAnswerEnvelope, "parseStatus" | "outcome">,
  summary: GroundingSummary,
): boolean =>
  session.retrieval.contexts.length > 0
  && !admitsPageEvidence(session.pageReadOutcome)
  && envelope.parseStatus === "valid_v2"
  && envelope.outcome === "answer"
  && summary.sourcedClaimCount === 0;

/**
 * A routine that yielded this turn stays parked on a step, and the answer closes by
 * pointing back to it (#1377) — unless the answer hands the visitor to a person. On an
 * agent set to hand retrieval misses over, a `no_support` decline is that hand-off. A
 * composed decline there gets no lead-back; a grounded answer commits its own outcome, so
 * its prompt tells it to leave the lead-back out of a `no_support` decline.
 */
export const declinePendingRoutineStep = (session: PreparedSession): RoutinePendingStep | undefined =>
  session.agent.handoffOnRetrievalMiss === true ? undefined : session.routineYield?.pendingStep;

/**
 * The decline (`no_support` or `out_of_scope`) the grounded answer committed in a valid
 * head without writing any text for it, or `null` when it did not. The commitment is
 * still a valid verdict, so the turn delivers the focused decline that outcome promised
 * instead of failing as a blank generation; a tail that failed to parse after the head
 * does not take it back. An empty `answer` commitment, or a decline outcome on a head
 * that did not parse, stays a generation failure.
 */
export const blankDeclineCommitment = (
  envelope: Pick<GroundedAnswerEnvelope, "protocolVersion" | "coverage" | "requestFocus" | "outcome">,
  answer: string,
): CommittedDeclineOutcome | null => {
  if (answer.trim()) {
    return null;
  }
  const outcome = headOfCompletedEnvelope(envelope)?.outcome;
  return outcome === "no_support" || outcome === "out_of_scope" ? outcome : null;
};

/**
 * The reason a blank decline is presented with. The composed decline only words the
 * reply; why the turn declined is what the head committed, so an `out_of_scope`
 * commitment never becomes a content gap that hands the visitor off. A decline model
 * that could not generate at all leaves the turn unavailable instead.
 */
export const blankDeclineReason = (committed: CommittedDeclineOutcome, composed: ComposedDecline): TurnDeclineReason =>
  composed.declineReason === "generation_unavailable"
    ? composed.declineReason
    : declineReasonForCommittedOutcome(committed);

/**
 * What a grounded envelope call answered with: text, or a decline its head committed
 * without writing any, whose wording the caller composes.
 */
export type EnvelopeAnswer =
  | { kind: "answer"; envelope: GroundedAnswerEnvelope }
  | { kind: "blank_decline"; committed: CommittedDeclineOutcome };

/** What the page-context call produced; `no_page` when the turn carries no page to answer from. */
export type PageContextAnswer = EnvelopeAnswer | { kind: "no_page" };
