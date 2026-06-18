export type ConversationOwnershipState = "ai_owned" | "human_owned";
export type ConversationOwnershipReason =
  | "routine_handoff"
  | "retrieval_miss"
  | "operator_takeover"
  | (string & {});

export interface ConversationOwnershipRecord {
  conversationId: string;
  workspaceId: string;
  state: ConversationOwnershipState;
  ownerAccountId: string | null;
  ownerDisplayName: string | null;
  reason: ConversationOwnershipReason | null;
  version: number;
  takenOverAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type ResumeClassification = "message_emitting" | "side_effect_only";

export interface ResolvedOwnership {
  state: ConversationOwnershipState;
  ownerAccountId: string | null;
  ownerDisplayName: string | null;
  reason: string | null;
  version: number | null;
  takenOverAt: Date | null;
}

export interface CanResumeInput {
  classification?: ResumeClassification;
}

export type CanResumeResult =
  | { ok: true }
  | { ok: false; reason: "human_owned_message_emitting_resume_deferred" };

export const resolveOwnership = (
  record: ConversationOwnershipRecord | null,
): ResolvedOwnership => {
  if (!record) {
    return {
      state: "ai_owned",
      ownerAccountId: null,
      ownerDisplayName: null,
      reason: null,
      version: null,
      takenOverAt: null,
    };
  }

  return {
    state: record.state,
    ownerAccountId: record.ownerAccountId,
    ownerDisplayName: record.ownerDisplayName,
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
