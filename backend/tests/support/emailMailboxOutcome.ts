import { isHeldReplyAttentionOpen } from "../../src/modules/handoff/heldReplies/heldReplyState.js";
import type { ConversationOwnershipRecord, HeldReplyRecord } from "../../src/modules/handoff/public.js";

/**
 * What happened to one inbound email, in the terms a support team uses: the customer got a reply
 * (`sent`), a draft waits for a teammate (`drafted`), nothing happened and no turn ran
 * (`silent`), or a person now owns the conversation (`handed_off`). Pure: the mailbox behaviour
 * harness reads the evidence from Postgres and the local provider's spool, and this decides.
 */

export type EmailBusinessOutcomeKind = "sent" | "drafted" | "silent" | "handed_off";

/**
 * The Inbox lane the conversation sits in afterwards, first match wins: a held draft waiting for a
 * decision (`approval`), a person's conversation (`handoff`), an undelivered reply
 * (`delivery_failed`), or nothing (`none`).
 */
export type EmailAttentionKind = "approval" | "handoff" | "delivery_failed" | "none";

export interface OwnershipSummary {
  state: "ai_owned" | "human_owned";
  reason: string | null;
}

/** A message the local provider accepted, as its spool records it. */
export interface SentEmailSummary {
  to: string;
  subject: string;
  text: string;
  /** `auto-generated` on agent-authored mail (RFC 3834); null on a teammate's own words. */
  autoSubmitted: string | null;
  messageId: string;
  inReplyTo: string | null;
}

export interface HeldReplySummary {
  id: string;
  state: string;
  holdReason: string;
  releaseKind: "operator" | "auto" | null;
  edited: boolean;
  supersededReason: string | null;
  /** The labels a teammate sees on the draft: the turn's outcome, grounding, coverage and hand-off. */
  labels: {
    outcome: string;
    grounding: string;
    coverage: string;
    handoffReason: string | null;
    suppressedEffects: string[];
  };
  draftText: string;
  attentionOpen: boolean;
}

/** The send intent that answered the email, and the message the provider accepted for it. */
export interface SendSummary {
  state: string;
  trigger: string;
  authorKind: string;
  haltReason: string | null;
  email: SentEmailSummary | null;
}

export interface EmailOutcomeEvidence {
  /** The email's delivery to the mailbox; null until the webhook's event has produced one. */
  delivery: {
    disposition: "drop" | "ingest_only" | "run_review_turn";
    reason: string;
    conversationId: string | null;
    /** Whether stage 1 finished with it. */
    settled: boolean;
  } | null;
  /** A review of the conversation is due, claimed, or retrying. */
  reviewPending: boolean;
  /** The newest held reply answering this email or a later one on its thread. */
  heldReply: HeldReplySummary | null;
  /** The send that answered this email, if one was made. */
  send: SendSummary | null;
  ownership: OwnershipSummary;
  /** Any held reply on the conversation still waits for a teammate. */
  attentionOpen: boolean;
  openDeliveryFailure: boolean;
  /** Why the channel's review set this email aside without a turn, as its thread note says; null when it did not. */
  setAside: string | null;
}

export interface EmailBusinessOutcome {
  kind: EmailBusinessOutcomeKind;
  /** The disposition, hold, release or hand-off reason behind `kind`, as the product records it. */
  reason: string;
  conversationId: string | null;
  heldReply?: HeldReplySummary;
  sentEmail?: SentEmailSummary;
  send?: SendSummary;
  ownership: OwnershipSummary;
  attentionKind: EmailAttentionKind;
}

/** Thrown when the evidence is read while the pipeline still has work for the email. */
export class EmailOutcomeUnsettled extends Error {
  constructor(readonly pending: string) {
    super(`The email's outcome is not settled yet: ${pending}`);
    this.name = "EmailOutcomeUnsettled";
  }
}

/** Send states that are still on their way to the provider. */
const UNSETTLED_SEND_STATES: ReadonlySet<string> = new Set(["queued"]);

/** Released held-reply states; the matching send carries the delivery. */
const RELEASED_STATES: ReadonlySet<string> = new Set(["released", "edited"]);

export const heldReplySummaryOf = (record: HeldReplyRecord): HeldReplySummary => ({
  id: record.id,
  state: record.state,
  holdReason: record.holdReason,
  releaseKind: record.releaseKind,
  edited: record.editedText !== null,
  supersededReason: record.supersededReason,
  labels: {
    outcome: record.facts.outcome,
    grounding: record.facts.grounding,
    coverage: record.facts.coverage,
    handoffReason: record.facts.handoff.requested ? record.facts.handoff.reason : null,
    suppressedEffects: record.facts.suppressedEffects.map((effect) => effect.skillName),
  },
  draftText: record.draft.text,
  attentionOpen: isHeldReplyAttentionOpen(record),
});

/** A conversation with no ownership row is the agent's. */
export const ownershipSummaryOf = (record: Pick<ConversationOwnershipRecord, "state" | "reason"> | null): OwnershipSummary =>
  record ? { state: record.state, reason: record.reason } : { state: "ai_owned", reason: null };

const attentionKindOf = (evidence: EmailOutcomeEvidence): EmailAttentionKind => {
  if (evidence.attentionOpen) return "approval";
  if (evidence.ownership.state === "human_owned") return "handoff";
  if (evidence.openDeliveryFailure) return "delivery_failed";
  return "none";
};

/** Who put the reply on its way: the channel's automatic send, a teammate's release, or a teammate's own reply. */
const sendReason = (send: SendSummary): string => {
  if (send.trigger === "auto_reply") return "auto";
  if (send.trigger === "held_release") return send.authorKind === "operator" ? "operator_edited" : "operator_released";
  return send.trigger;
};

const reviewedOutcome = (evidence: EmailOutcomeEvidence): Pick<EmailBusinessOutcome, "kind" | "reason"> => {
  const { heldReply, send, ownership } = evidence;
  if (send?.email) return { kind: "sent", reason: sendReason(send) };
  if (send) return { kind: heldReply?.state === "pending" ? "drafted" : "silent", reason: `send_${send.state}` };
  if (heldReply) {
    if (heldReply.state === "pending") return { kind: "drafted", reason: heldReply.holdReason };
    if (heldReply.state === "discarded") return { kind: "drafted", reason: "discarded" };
    if (heldReply.state === "superseded") {
      return ownership.state === "human_owned"
        ? { kind: "handed_off", reason: ownership.reason ?? "human_owned" }
        : { kind: "drafted", reason: `superseded_${heldReply.supersededReason ?? "unknown"}` };
    }
    if (RELEASED_STATES.has(heldReply.state)) throw new EmailOutcomeUnsettled(`held reply ${heldReply.id} released without a send`);
  }
  if (ownership.state === "human_owned") return { kind: "handed_off", reason: ownership.reason ?? "human_owned" };
  return { kind: "silent", reason: evidence.setAside ?? "no_reply" };
};

/**
 * The business outcome of one inbound email. Mail set aside before a turn (dropped, or ingested
 * for a person) is `silent` with its disposition reason. A reviewed email is `sent` once the
 * provider accepted a reply to it, `drafted` while a draft waits (reason: the hold reason),
 * `handed_off` when the review left a person owning the conversation, and `silent` otherwise, with
 * the reason its review's thread note gives (`no_reply_needed`) or `no_reply`.
 */
export const classifyEmailOutcome = (evidence: EmailOutcomeEvidence): EmailBusinessOutcome => {
  const { delivery } = evidence;
  if (!delivery) throw new EmailOutcomeUnsettled("no delivery recorded");
  if (!delivery.settled) throw new EmailOutcomeUnsettled("delivery still processing");
  if (evidence.reviewPending) throw new EmailOutcomeUnsettled("review still due");
  if (evidence.heldReply?.state === "queued_auto") throw new EmailOutcomeUnsettled("automatic reply still queued");
  if (evidence.send && UNSETTLED_SEND_STATES.has(evidence.send.state)) throw new EmailOutcomeUnsettled("send still queued");

  const decided = delivery.disposition === "run_review_turn"
    ? reviewedOutcome(evidence)
    : { kind: "silent" as const, reason: delivery.reason };
  return {
    ...decided,
    conversationId: delivery.conversationId,
    ...(evidence.heldReply ? { heldReply: evidence.heldReply } : {}),
    ...(evidence.send?.email ? { sentEmail: evidence.send.email } : {}),
    ...(evidence.send ? { send: evidence.send } : {}),
    ownership: evidence.ownership,
    attentionKind: attentionKindOf(evidence),
  };
};
