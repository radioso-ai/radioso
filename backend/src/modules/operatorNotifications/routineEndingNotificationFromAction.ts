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
 * What a routine-ending notice is about, resolved at delivery: display names next to the ids
 * the payload carries, and the facts already stored about the conversation. Absent when not
 * resolved.
 */
export interface RoutineEndingNotificationSubject {
  agentName: string | null;
  routineName: string | null;
  conversation?: OperatorNoticeConversationFacts;
}

/** The `reason` a payload that names none reports, per kind of ending. */
const DEFAULT_REASON: Record<RoutineEndingOperatorNotification["kind"], string> = {
  handoff: "routine_handoff",
  completion: "routine_completed",
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
  /** Used only when the payload itself omits the field. */
  fallback: { conversationId: string; workspaceId: string };
  subject?: RoutineEndingNotificationSubject;
}): RoutineEndingOperatorNotification => {
  const conversationId = asString(input.payload.conversationId) ?? input.fallback.conversationId;
  const workspaceId = asString(input.payload.workspaceId) ?? input.fallback.workspaceId;
  const agentId = asString(input.payload.agentId) ?? "unknown";
  const reason = asString(input.payload.reason) ?? DEFAULT_REASON[input.kind];
  const routineId = asString(input.payload.routineId);
  const collected = collectedFromPayload(input.payload.collected);
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
