import type { OperatorNotificationDispatcher } from "../../../operatorNotifications/public.js";
import type { ActionHandler, ActionHandlerContext } from "./actionDispatcher.js";

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

export class HandoffNotifyActionHandler implements ActionHandler {
  constructor(private readonly dispatcher: Pick<OperatorNotificationDispatcher, "dispatch">) {}

  async handle(input: { payload: Record<string, unknown>; context: ActionHandlerContext }): Promise<void> {
    const conversationId = asString(input.payload.conversationId) ?? input.context.conversationId ?? "unknown";
    const workspaceId = asString(input.payload.workspaceId) ?? input.context.workspaceId ?? "unknown";
    const agentId = asString(input.payload.agentId) ?? "unknown";
    const reason = asString(input.payload.reason) ?? "routine_handoff";
    const dashboardPath = asString(input.payload.dashboardPath) ?? `/conversations/${conversationId}`;
    await this.dispatcher.dispatch({
      kind: "handoff",
      workspaceId,
      conversationId,
      agentId,
      reason,
      dashboardPath,
    }, {
      requestId: input.context.requestId,
      workspaceId: input.context.workspaceId,
      accountId: input.context.accountId,
      conversationId: input.context.conversationId,
      idempotencyKey: input.context.idempotencyKey,
      attempt: input.context.attempt,
    });
  }
}
