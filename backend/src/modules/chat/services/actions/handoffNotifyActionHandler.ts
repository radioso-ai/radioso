import type {
  HandoffCollectedValue,
  HandoffOperatorNotification,
  OperatorNotificationDispatcher,
} from "../../../operatorNotifications/public.js";
import type { ActionHandler, ActionHandlerContext } from "./actionDispatcher.js";

/**
 * Resolves the display names a handoff notice shows next to the ids it carries. A name the
 * lookup cannot find (an agent or routine deleted after the handoff was queued) resolves to
 * `null`; the notice must still deliver, so implementations never throw for a missing row.
 */
export interface HandoffNotificationSubjectResolver {
  resolve(input: {
    workspaceId: string;
    agentId: string;
    routineId: string | null;
  }): Promise<{ agentName: string | null; routineName: string | null }>;
}

const asString = (value: unknown): string | null =>
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

export class HandoffNotifyActionHandler implements ActionHandler {
  constructor(
    private readonly dispatcher: Pick<OperatorNotificationDispatcher, "dispatch">,
    private readonly subjects?: HandoffNotificationSubjectResolver,
  ) {}

  async handle(input: { payload: Record<string, unknown>; context: ActionHandlerContext }): Promise<void> {
    const conversationId = asString(input.payload.conversationId) ?? input.context.conversationId ?? "unknown";
    const workspaceId = asString(input.payload.workspaceId) ?? input.context.workspaceId ?? "unknown";
    const agentId = asString(input.payload.agentId) ?? "unknown";
    const reason = asString(input.payload.reason) ?? "routine_handoff";
    const routineId = asString(input.payload.routineId);
    const collected = collectedFromPayload(input.payload.collected);
    const subject = await this.subjects?.resolve({ workspaceId, agentId, routineId });
    const notification: HandoffOperatorNotification = {
      kind: "handoff",
      workspaceId,
      conversationId,
      agentId,
      reason,
      ...(subject ? { agentName: subject.agentName } : {}),
      ...(routineId ? { routine: { id: routineId, name: subject?.routineName ?? null } } : {}),
      ...(collected ? { collected } : {}),
    };
    await this.dispatcher.dispatch(notification, {
      requestId: input.context.requestId,
      workspaceId: input.context.workspaceId,
      accountId: input.context.accountId,
      conversationId: input.context.conversationId,
      idempotencyKey: input.context.idempotencyKey,
      attempt: input.context.attempt,
    });
  }
}
