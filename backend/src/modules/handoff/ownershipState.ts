import { teammateLabel } from "../auth/contracts/index.js";

export type ConversationOwnershipState = "ai_owned" | "human_owned";
export type ConversationOwnershipScope = "human_owned";
export type ConversationOwnershipReason =
  | "routine_handoff"
  | "retrieval_miss"
  | "operator_takeover"
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
  /** The owner's teammate label as it was when they claimed the conversation. */
  ownerStoredLabel: string | null;
  reason: ConversationOwnershipReason | null;
  version: number;
  takenOverAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * How operator surfaces name the owner: their teammate label from the profile as it is now, so a
 * rename shows at once, else the label stored at claim time for a row that names no user.
 * Operator-facing only — a teammate label can be an email, so it never reaches a visitor.
 */
export const ownerLabel = (
  record: Pick<ConversationOwnershipRecord, "ownerProfile" | "ownerStoredLabel">,
): string | null => (record.ownerProfile ? teammateLabel(record.ownerProfile) : record.ownerStoredLabel);

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

export const presentOwnership = (record: ConversationOwnershipRecord): ConversationOwnershipView => ({
  conversationId: record.conversationId,
  workspaceId: record.workspaceId,
  state: record.state,
  ownerAccountId: record.ownerAccountId,
  ownerUserId: record.ownerUserId,
  ownerDisplayName: ownerLabel(record),
  reason: record.reason,
  version: record.version,
  takenOverAt: record.takenOverAt,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
});

type ResumeClassification = "message_emitting" | "side_effect_only";

interface ResolvedOwnership {
  state: ConversationOwnershipState;
  ownerAccountId: string | null;
  ownerUserId: string | null;
  ownerDisplayName: string | null;
  reason: string | null;
  version: number | null;
  takenOverAt: Date | null;
}

interface CanResumeInput {
  classification?: ResumeClassification;
}

type CanResumeResult =
  | { ok: true }
  | { ok: false; reason: "human_owned_message_emitting_resume_deferred" };

export const resolveOwnership = (
  record: ConversationOwnershipRecord | null,
): ResolvedOwnership => {
  if (!record) {
    return {
      state: "ai_owned",
      ownerAccountId: null,
      ownerUserId: null,
      ownerDisplayName: null,
      reason: null,
      version: null,
      takenOverAt: null,
    };
  }

  return {
    state: record.state,
    ownerAccountId: record.ownerAccountId,
    ownerUserId: record.ownerUserId,
    ownerDisplayName: ownerLabel(record),
    reason: record.reason,
    version: record.version,
    takenOverAt: record.takenOverAt,
  };
};

export const isHumanOwned = (record: ConversationOwnershipRecord | null): boolean =>
  resolveOwnership(record).state === "human_owned";

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
