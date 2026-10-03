import {
  CLOSING_ACTIVITY_KINDS,
  CONVERSATION_ACTIVITY_KINDS,
  FEEDBACK_ACTIVITY_KINDS,
  type ClosedInboxItemKind,
  type ClosingActivityKind,
  type ConversationActivityEntry,
  type ConversationActivityKind,
  type ConversationActivityPerson,
  type ConversationActivityReadScope,
  type ConversationActivityRecord,
} from "./contracts/index.js";

const CLOSED_ITEM_KIND: Record<ClosingActivityKind, ClosedInboxItemKind> = {
  handed_back: "handoff",
  approval_decided: "approval",
  feedback_resolved: "negative_feedback",
  feedback_dismissed: "negative_feedback",
  held_reply_released: "approval",
  delivery_failure_cleared: "delivery_failed",
};

export const closedItemKind = (kind: ClosingActivityKind): ClosedInboxItemKind => CLOSED_ITEM_KIND[kind];

const FEEDBACK_KINDS: ReadonlySet<ConversationActivityKind> = new Set(FEEDBACK_ACTIVITY_KINDS);

const visibleIn = (scope: ConversationActivityReadScope) => (kind: ConversationActivityKind): boolean =>
  scope.includeFeedback || !FEEDBACK_KINDS.has(kind);

/** The kinds a read within `scope` carries. */
export const visibleActivityKinds = (scope: ConversationActivityReadScope): ConversationActivityKind[] =>
  CONVERSATION_ACTIVITY_KINDS.filter(visibleIn(scope));

/** The closing kinds a read within `scope` carries. */
export const visibleClosingKinds = (scope: ConversationActivityReadScope): ClosingActivityKind[] =>
  CLOSING_ACTIVITY_KINDS.filter(visibleIn(scope));

const stringField = (detail: Record<string, unknown>, key: string): string | null => {
  const value = detail[key];
  return typeof value === "string" ? value : null;
};

const decisionField = (detail: Record<string, unknown>): ConversationActivityEntry["decision"] => {
  const decision = detail.decision;
  if (decision === null || typeof decision !== "object" || Array.isArray(decision)) {
    return null;
  }
  const { optionId, label } = decision as Record<string, unknown>;
  return typeof optionId === "string" && typeof label === "string" ? { optionId, label } : null;
};

/** Every teammate the records name, once each, for one batched label lookup. */
export const activityUserIds = (records: readonly ConversationActivityRecord[]): string[] => {
  const ids = new Set<string>();
  for (const record of records) {
    for (const id of [record.actorUserId, record.subjectUserId, stringField(record.detail, "fromUserId")]) {
      if (id !== null) {
        ids.add(id);
      }
    }
  }
  return [...ids];
};

const person = (userId: string | null, labels: ReadonlyMap<string, string>): ConversationActivityPerson | null =>
  userId === null ? null : { userId, label: labels.get(userId) ?? null };

/**
 * A stored event as operator surfaces present it, each teammate labelled as they are now. A
 * kind-specific field is read only on its kinds, so another kind's `detail` never fills it.
 */
export const presentActivity = (
  record: ConversationActivityRecord,
  labels: ReadonlyMap<string, string>,
): ConversationActivityEntry => {
  const isFeedback = FEEDBACK_KINDS.has(record.kind);
  return {
    id: record.id,
    kind: record.kind,
    createdAt: record.createdAt.toISOString(),
    actor: person(record.actorUserId, labels),
    subject: person(record.subjectUserId, labels),
    from: person(stringField(record.detail, "fromUserId"), labels),
    handoffReason: record.kind === "handoff_requested" ? stringField(record.detail, "reason") : null,
    decision: record.kind === "approval_decided" ? decisionField(record.detail) : null,
    resolution: isFeedback ? stringField(record.detail, "resolution") : null,
    assistantMessageId: isFeedback ? stringField(record.detail, "assistantMessageId") : null,
  };
};
