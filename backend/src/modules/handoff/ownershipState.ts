import { teammateLabel } from "../auth/contracts/index.js";

export type ConversationOwnershipState = "ai_owned" | "human_owned";
export type ConversationOwnershipScope = "human_owned";
export type ConversationOwnershipReason =
  | "routine_handoff"
  | "routine_stuck"
  | "retrieval_miss"
  | "operator_takeover"
  /** The conversation arrived at a mailbox that only operators answer. */
  | "operator_only_mailbox"
  /** The channel's budget for generated replies ran out. */
  | "generation_budget"
  /** A reviewed turn could not produce a reply to review. */
  | "review_unavailable"
  /**
   * A channel's policy change (an upgrade, another agent) superseded the draft the customer was
   * waiting on and runs no review for that message again. Its own reason rather than
   * `review_unavailable`, because no review failed: the operator changed the rules under it.
   */
  | "policy_changed"
  | (string & {});

/** The owning teammate's profile as it is now. */
interface ConversationOwnerProfile {
  displayName: string | null;
  email: string;
}

export interface ConversationOwnershipRecord {
  conversationId: string;
  workspaceId: string;
  state: ConversationOwnershipState;
  /** The organisation the workspace belongs to; shared by every teammate, so it never names a person. */
  ownerAccountId: string | null;
  /** The teammate handling the conversation. Null while unclaimed and on rows claimed before per-user ownership. */
  ownerUserId: string | null;
  /** The owner's profile, read with the row. Null when the row names no user or the user is gone. */
  ownerProfile: ConversationOwnerProfile | null;
  /**
   * The owner's teammate label as it was when they claimed the conversation. It names them only
   * while the row still names their user; once the user is deleted it is never presented.
   */
  ownerStoredLabel: string | null;
  reason: ConversationOwnershipReason | null;
  version: number;
  takenOverAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * How operator surfaces name the owner: their teammate label from the profile as it is now, so a
 * rename shows at once, else the label stored at claim time. A row that names no user has no
 * owner to name: it waits for a teammate, even when deleting its owner's user left the stored
 * label behind. Operator-facing only — a teammate label can be an email, so it never reaches a
 * visitor.
 */
export const ownerLabel = (
  record: Pick<ConversationOwnershipRecord, "ownerUserId" | "ownerProfile" | "ownerStoredLabel">,
): string | null => {
  if (record.ownerUserId === null) {
    return null;
  }
  return record.ownerProfile ? teammateLabel(record.ownerProfile) : record.ownerStoredLabel;
};

/** The ownership as operator surfaces present it: the owner named by `ownerDisplayName`. */
interface ConversationOwnershipView {
  conversationId: string;
  workspaceId: string;
  state: ConversationOwnershipState;
  ownerAccountId: string | null;
  ownerUserId: string | null;
  ownerDisplayName: string | null;
  reason: ConversationOwnershipReason | null;
  version: number;
  takenOverAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A record that names no teammate presents no owner and no claim time, whatever the row kept:
 * deleting the owner's user nulls only `owner_user_id`, and a hand-back leaves `taken_over_at`.
 */
export const presentOwnership = (record: ConversationOwnershipRecord): ConversationOwnershipView => ({
  conversationId: record.conversationId,
  workspaceId: record.workspaceId,
  state: record.state,
  ownerAccountId: record.ownerAccountId,
  ownerUserId: record.ownerUserId,
  ownerDisplayName: ownerLabel(record),
  reason: record.reason,
  version: record.version,
  takenOverAt: record.ownerUserId === null ? null : record.takenOverAt,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
});

type ResumeClassification = "message_emitting" | "side_effect_only";

interface CanResumeInput {
  classification?: ResumeClassification;
}

type CanResumeResult =
  | { ok: true }
  | { ok: false; reason: "human_owned_message_emitting_resume_deferred" };

export const isHumanOwned = (record: ConversationOwnershipRecord | null): boolean =>
  record?.state === "human_owned";

// FR-022 compatibility stub: resume work is message-emitting unless the host marks it
// side-effect-only/safe. Message-emitting resumes must park while a human owns the
// conversation so the AI never speaks into a manually owned thread.
export const canResume = (
  record: ConversationOwnershipRecord | null,
  input: CanResumeInput = {},
): CanResumeResult => {
  if (!isHumanOwned(record)) {
    return { ok: true };
  }

  if (input.classification === "side_effect_only") {
    return { ok: true };
  }

  return { ok: false, reason: "human_owned_message_emitting_resume_deferred" };
};
