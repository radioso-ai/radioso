/**
 * The held-reply machine: what a review result is born as, which events move a held reply out of
 * which state and to what, and when a release is refused. Pure; the repository's conditional
 * updates and the service's checks both read their rules from here.
 */

export const HELD_REPLY_STATES = ["pending", "queued_auto", "released", "edited", "discarded", "superseded"] as const;

export type HeldReplyState = typeof HELD_REPLY_STATES[number];

/** Why a live draft was replaced. */
export type SupersedeReason = "newer_inbound" | "takeover" | "operator_reply" | "policy_changed";

/** Who sent a released held reply: a teammate, or the channel's authorized automatic send. */
type HeldReplyReleaseKind = "operator" | "auto";

/** Why a held reply stopped waiting for a teammate. */
export type HeldReplyAttentionClearReason = "released" | "operator_reply" | "takeover" | "superseded";

/** Why a teammate's release changed nothing. */
export type HeldReplyReleaseRefusal = "not_pending" | "ownership_changed" | "policy_changed" | "channel_not_ready";

/**
 * The review turn's facts as the held reply keeps them, for operators to judge the draft by. The
 * codes are the host's; handoff stores and presents them and decides nothing on them.
 */
export interface HeldReplyTurnFacts {
  outcome: string;
  grounding: string;
  coverage: string;
  handoff: { requested: false } | { requested: true; reason: string };
  suppressedEffects: readonly { skillName: string }[];
  citationCount: number;
}

/** The reply a review turn produced: its text, and the host-owned presentation it is written with. */
export interface HeldReplyDraft {
  readonly text: string;
  readonly presentation: Readonly<Record<string, unknown>>;
}

export interface HeldReplyRecord {
  id: string;
  workspaceId: string;
  conversationId: string;
  /** The author: the agent whose review produced the draft. */
  agentId: string | null;
  state: HeldReplyState;
  releaseKind: HeldReplyReleaseKind | null;
  reviewRef: string | null;
  /** The customer message the draft answers, which is also its review turn's request message. */
  answersMessageId: string;
  ownershipVersion: number;
  /** The producer's policy the review ran under, by an opaque ref and its version; null when none is bound. */
  policy: { ref: string; version: number } | null;
  holdReason: string;
  facts: HeldReplyTurnFacts;
  draft: HeldReplyDraft;
  editedText: string | null;
  editorUserId: string | null;
  releaserUserId: string | null;
  discardedByUserId: string | null;
  releasedMessageId: string | null;
  supersededReason: SupersedeReason | null;
  attentionClearedAt: Date | null;
  attentionClearedReason: HeldReplyAttentionClearReason | null;
  decidedAt: Date | null;
  createdAt: Date;
}

/** The states a draft is live in: undecided, and at most one per conversation. */
const LIVE_HELD_REPLY_STATES = ["pending", "queued_auto"] as const satisfies readonly HeldReplyState[];

export type HeldReplyEvent =
  | { kind: "release"; edited: boolean }
  | { kind: "discard" }
  | { kind: "materialize"; authorized: boolean }
  | { kind: "supersede"; reason: SupersedeReason }
  | { kind: "clear_discarded_attention"; reason: "operator_reply" | "takeover" };

type HeldReplyEventKind = HeldReplyEvent["kind"];

/** What an event writes on a held reply it applies to. */
export interface HeldReplyTransition {
  state: HeldReplyState;
  releaseKind: HeldReplyReleaseKind | null;
  /** Why attention closed; null while it stays open. */
  attentionCleared: HeldReplyAttentionClearReason | null;
  /** A queued send returned to a teammate is held anew, for this reason. */
  holdReason?: "authority_changed";
}

const supersededAttention = (reason: SupersedeReason): HeldReplyAttentionClearReason =>
  // A teammate who replied or took over dealt with the conversation: attention closes with their act.
  reason === "operator_reply" || reason === "takeover" ? reason : "superseded";

const MACHINE: {
  [K in HeldReplyEventKind]: {
    from: readonly HeldReplyState[];
    to: (event: Extract<HeldReplyEvent, { kind: K }>) => HeldReplyTransition;
  };
} = {
  release: {
    from: ["pending"],
    to: (event) => ({ state: event.edited ? "edited" : "released", releaseKind: "operator", attentionCleared: "released" }),
  },
  discard: {
    from: ["pending"],
    to: () => ({ state: "discarded", releaseKind: null, attentionCleared: null }),
  },
  materialize: {
    from: ["queued_auto"],
    to: (event) => event.authorized
      ? { state: "released", releaseKind: "auto", attentionCleared: "released" }
      : { state: "pending", releaseKind: null, attentionCleared: null, holdReason: "authority_changed" },
  },
  supersede: {
    from: LIVE_HELD_REPLY_STATES,
    to: (event) => ({ state: "superseded", releaseKind: null, attentionCleared: supersededAttention(event.reason) }),
  },
  clear_discarded_attention: {
    from: ["discarded"],
    to: (event) => ({ state: "discarded", releaseKind: null, attentionCleared: event.reason }),
  },
};

/** The states an event moves a held reply out of; in any other state it changes nothing. */
export const heldReplyEventSources = (kind: HeldReplyEventKind): readonly HeldReplyState[] => MACHINE[kind].from;

/** What an event writes wherever it applies. */
export const heldReplyEventTarget = <E extends HeldReplyEvent>(event: E): HeldReplyTransition =>
  (MACHINE[event.kind].to as (event: E) => HeldReplyTransition)(event);

/** The event's transition from `state`; null when it does not apply there and nothing changes. */
export const heldReplyTransition = (state: HeldReplyState, event: HeldReplyEvent): HeldReplyTransition | null =>
  heldReplyEventSources(event.kind).includes(state) ? heldReplyEventTarget(event) : null;

/**
 * What the review ran under against what is current as its result is recorded: the ownership
 * version, the policy version its channel locks now (null when the channel cannot vouch for it;
 * `policy` null when the result binds none), and whether it answers the newest customer message.
 */
export interface HeldReplyBindingCheck {
  ownership: { bound: number; current: number };
  policy: { bound: number; current: number | null } | null;
  answersLatestCustomerMessage: boolean;
}

/**
 * Why the binding no longer holds; null while it does. Every ownership move that reaches a draft
 * hands the conversation to a person, so a moved ownership reads as a takeover.
 */
const staleBinding = (binding: HeldReplyBindingCheck): SupersedeReason | null => {
  if (!binding.answersLatestCustomerMessage) {
    return "newer_inbound";
  }
  if (binding.ownership.bound !== binding.ownership.current) {
    return "takeover";
  }
  if (binding.policy && binding.policy.bound !== binding.policy.current) {
    return "policy_changed";
  }
  return null;
};

/**
 * What a held review result is born as: pending while its binding holds, and superseded once it
 * does not, so a newer review runs.
 */
export const heldBirth = (
  binding: HeldReplyBindingCheck,
): { state: "pending" } | { state: "superseded"; reason: SupersedeReason } => {
  const stale = staleBinding(binding);
  return stale ? { state: "superseded", reason: stale } : { state: "pending" };
};

/**
 * What a result to publish is born as: queued for an automatic send only with its binding current
 * and a send reserved (reserved only once the binding is known current); otherwise it waits for a
 * teammate with the reason, unless a newer customer message replaced it.
 */
export const autoSendBirth = (
  binding: HeldReplyBindingCheck,
  sendBudgetReserved: boolean,
):
  | { state: "queued_auto" }
  | { state: "pending"; holdReason: "authority_changed" | "send_budget" }
  | { state: "superseded"; reason: "newer_inbound" } => {
  const stale = staleBinding(binding);
  if (stale === "newer_inbound") {
    return { state: "superseded", reason: stale };
  }
  if (stale) {
    return { state: "pending", holdReason: "authority_changed" };
  }
  return sendBudgetReserved ? { state: "queued_auto" } : { state: "pending", holdReason: "send_budget" };
};

/**
 * Why a teammate's release must change nothing; null when it may go ahead. It goes ahead only from
 * a pending draft whose ownership and policy are both still the ones the review ran under, and a
 * draft a channel produced needs that channel able to vouch for the policy and deliver the reply.
 */
export const releaseRefusal = (input: {
  state: HeldReplyState;
  ownership: { bound: number; current: number };
  /** The bound policy version and the one its channel locked now (null: it cannot vouch); null when none is bound. */
  policy: { bound: number; current: number | null } | null;
  /** Whether replies on the conversation have a delivery route outside the web. */
  routed: boolean;
}): HeldReplyReleaseRefusal | null => {
  if (!heldReplyEventSources("release").includes(input.state)) {
    return "not_pending";
  }
  if (input.ownership.bound !== input.ownership.current) {
    return "ownership_changed";
  }
  if (input.policy === null) {
    return null;
  }
  if (input.policy.current === null) {
    return "channel_not_ready";
  }
  if (input.policy.bound !== input.policy.current) {
    return "policy_changed";
  }
  return input.routed ? null : "channel_not_ready";
};

/** Whether the held reply waits for a teammate. A queued automatic send never does. */
export const isHeldReplyAttentionOpen = (record: Pick<HeldReplyRecord, "state" | "attentionClearedAt">): boolean =>
  record.state !== "queued_auto" && record.attentionClearedAt === null;
