import type {
  HandoffCollectedValue,
  OperatorNoticeConversationFacts,
  OperatorNoticeTemplate,
  RoutineEndingOperatorNotification,
} from "./operatorNotification.js";

export const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const isCollectedValue = (value: unknown): value is HandoffCollectedValue =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Keeps only the slot values a notice can print; structured slot values are left out. */
const collectedFromPayload = (value: unknown): Record<string, HandoffCollectedValue> | null => {
  if (!isRecord(value)) {
    return null;
  }
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, HandoffCollectedValue] => isCollectedValue(entry[1])),
  );
};

/**
 * What a routine-ending notice is about, resolved at delivery from the queued row's conversation.
 */
export interface RoutineEndingNotificationSubject {
  agentId: string | null;
  agentName: string | null;
  routineName: string | null;
  /** The routine's declared slot keys, in declaration order; absent when the routine no longer exists. */
  routineSlotKeys?: readonly string[];
  conversation?: OperatorNoticeConversationFacts;
}

/**
 * A queued payload's `collected` is jsonb, which stores an object's keys in its own order, so
 * the values come back out of the order the routine declares its slots in. The declared slots
 * lead, in that order; a key the routine no longer declares follows in its stored position.
 * Without the routine's slot order, the stored order stands.
 */
const inDeclaredSlotOrder = (
  collected: Record<string, HandoffCollectedValue>,
  slotKeys: readonly string[] | undefined,
): Record<string, HandoffCollectedValue> => {
  if (!slotKeys) {
    return collected;
  }
  const declared = new Set(slotKeys);
  const keys = [
    ...slotKeys.filter((key) => Object.hasOwn(collected, key)),
    ...Object.keys(collected).filter((key) => !declared.has(key)),
  ];
  return Object.fromEntries(keys.map((key) => [key, collected[key]]));
};

/** Keeps only the authored text fields; an empty notice means "use the defaults". */
const noticeFromPayload = (value: unknown): OperatorNoticeTemplate | null => {
  if (!isRecord(value)) {
    return null;
  }
  const subject = asString(value.subject);
  const intro = asString(value.intro);
  return subject || intro
    ? { ...(subject ? { subject } : {}), ...(intro ? { intro } : {}) }
    : null;
};

/**
 * Builds the same {@link RoutineEndingOperatorNotification} the real dispatch handler sends, from
 * a `handoff.notify` or `completion.notify` action payload and its (already-resolved) subject.
 * Shared by the durable dispatch handler — whose subject comes from a database lookup — and a
 * Test Chat turn's notice preview — whose subject is already in memory from the turn that just
 * ran — so neither can drift from what {@link formatRoutineEndingNotification} renders for the
 * other.
 */
export const routineEndingNotificationFromAction = (input: {
  kind: RoutineEndingOperatorNotification["kind"];
  payload: Record<string, unknown>;
  /**
   * The queued action row's own ids: authoritative regardless of what the payload carries. A
   * routine action-step payload can carry visitor-filled variables under any key, so a payload
   * copy of these ids (even one the system wrote itself) must never override the row's own ids
   * for routing or lookups.
   */
  ids: { conversationId: string; workspaceId: string; agentId: string | null };
  /** Used only when the payload itself omits the field. */
  fallback: { reason: string };
  subject?: RoutineEndingNotificationSubject;
}): RoutineEndingOperatorNotification => {
  const conversationId = input.ids.conversationId;
  const workspaceId = input.ids.workspaceId;
  const agentId = input.ids.agentId ?? "unknown";
  const reason = asString(input.payload.reason) ?? input.fallback.reason;
  const routineId = asString(input.payload.routineId);
  const stored = collectedFromPayload(input.payload.collected);
  const collected = stored ? inDeclaredSlotOrder(stored, input.subject?.routineSlotKeys) : null;
  const notice = noticeFromPayload(input.payload.notice);
  return {
    kind: input.kind,
    workspaceId,
    conversationId,
    agentId,
    reason,
    ...(input.subject ? { agentName: input.subject.agentName } : {}),
    ...(routineId ? { routine: { id: routineId, name: input.subject?.routineName ?? null } } : {}),
    ...(collected ? { collected } : {}),
    ...(notice ? { notice } : {}),
    ...(input.subject?.conversation ? { conversation: input.subject.conversation } : {}),
  };
};
