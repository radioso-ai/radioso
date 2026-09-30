import type { HandoffCollectedValue, HandoffOperatorNotification } from "./operatorNotification.js";

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

/** Display names a handoff notice shows next to the ids it carries; absent when not resolved. */
interface HandoffNotifyActionSubject {
  agentName: string | null;
  routineName: string | null;
}

/**
 * Builds the same {@link HandoffOperatorNotification} the real dispatch handler sends, from a
 * `handoff.notify` action payload and its (already-resolved) subject names. Shared by the
 * durable dispatch handler — whose names come from a database lookup — and a Test Chat turn's
 * hand-off preview — whose names are already in memory from the turn that just ran — so
 * neither can drift from what {@link formatHandoffNotification} renders for the other.
 */
export const handoffNotificationFromAction = (input: {
  payload: Record<string, unknown>;
  /** Used only when the payload itself omits the field. */
  fallback: { conversationId: string; workspaceId: string };
  subject?: HandoffNotifyActionSubject;
}): HandoffOperatorNotification => {
  const conversationId = asString(input.payload.conversationId) ?? input.fallback.conversationId;
  const workspaceId = asString(input.payload.workspaceId) ?? input.fallback.workspaceId;
  const agentId = asString(input.payload.agentId) ?? "unknown";
  const reason = asString(input.payload.reason) ?? "routine_handoff";
  const routineId = asString(input.payload.routineId);
  const collected = collectedFromPayload(input.payload.collected);
  return {
    kind: "handoff",
    workspaceId,
    conversationId,
    agentId,
    reason,
    ...(input.subject ? { agentName: input.subject.agentName } : {}),
    ...(routineId ? { routine: { id: routineId, name: input.subject?.routineName ?? null } } : {}),
    ...(collected ? { collected } : {}),
  };
};
