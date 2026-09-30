import type {
  ClosedInboxItemKind,
  ClosingActivityKind,
  ConversationActivityEntry,
  ConversationActivityKind,
  ConversationActivityPerson,
  ConversationActivityRecord,
} from "./contracts/index.js";

const CLOSED_ITEM_KIND: Record<ClosingActivityKind, ClosedInboxItemKind> = {
  handed_back: "handoff",
  approval_decided: "approval",
  feedback_resolved: "negative_feedback",
  feedback_dismissed: "negative_feedback",
};

export const closedItemKind = (kind: ClosingActivityKind): ClosedInboxItemKind => CLOSED_ITEM_KIND[kind];

export const isClosingKind = (kind: ConversationActivityKind): kind is ClosingActivityKind =>
  Object.hasOwn(CLOSED_ITEM_KIND, kind);

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

/** A stored event as operator surfaces present it, each teammate labelled as they are now. */
export const presentActivity = (
  record: ConversationActivityRecord,
  labels: ReadonlyMap<string, string>,
): ConversationActivityEntry => ({
  id: record.id,
  kind: record.kind,
  createdAt: record.createdAt.toISOString(),
  actor: person(record.actorUserId, labels),
  subject: person(record.subjectUserId, labels),
  from: person(stringField(record.detail, "fromUserId"), labels),
  handoffReason: record.kind === "handoff_requested" ? stringField(record.detail, "reason") : null,
  decision: record.kind === "approval_decided" ? decisionField(record.detail) : null,
  resolution: stringField(record.detail, "resolution"),
  assistantMessageId: stringField(record.detail, "assistantMessageId"),
});
