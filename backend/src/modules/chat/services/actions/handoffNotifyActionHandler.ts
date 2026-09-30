import {
  asString,
  handoffNotificationFromAction,
  type OperatorNotificationDispatcher,
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

export class HandoffNotifyActionHandler implements ActionHandler {
  constructor(
    private readonly dispatcher: Pick<OperatorNotificationDispatcher, "dispatch">,
    private readonly subjects?: HandoffNotificationSubjectResolver,
  ) {}

  async handle(input: { payload: Record<string, unknown>; context: ActionHandlerContext }): Promise<void> {
    const conversationId = asString(input.payload.conversationId) ?? input.context.conversationId ?? "unknown";
    const workspaceId = asString(input.payload.workspaceId) ?? input.context.workspaceId ?? "unknown";
    const agentId = asString(input.payload.agentId) ?? "unknown";
    const routineId = asString(input.payload.routineId);
    const subject = await this.subjects?.resolve({ workspaceId, agentId, routineId });
    const notification = handoffNotificationFromAction({
      payload: input.payload,
      fallback: { conversationId, workspaceId },
      ...(subject ? { subject } : {}),
    });
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
