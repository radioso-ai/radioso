import type { ActionHandler, ActionHandlerContext } from "./actionDispatcher.js";
import type { OperatorNotificationDispatcher } from "../../../operatorNotifications/public.js";

/**
 * Out-of-band notification that a routine suspended at an approval gate and a human must
 * decide before it resumes. Reuses the contact-delivery transport (workspace recipients /
 * signed webhook) like `handoff.notify`; the worker dispatches it under the turn's
 * idempotency key so a redelivery never double-sends. The decision itself is resolved via
 * the authenticated decision endpoint — this only carries the operator there.
 */
export const APPROVAL_REQUEST_ACTION_TYPE = "approval.request";

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

export class ApprovalRequestActionHandler implements ActionHandler {
  constructor(private readonly dispatcher: Pick<OperatorNotificationDispatcher, "dispatch">) {}

  async handle(input: { payload: Record<string, unknown>; context: ActionHandlerContext }): Promise<void> {
    const conversationId = asString(input.payload.conversationId) ?? input.context.conversationId ?? "unknown";
    const workspaceId = asString(input.payload.workspaceId) ?? input.context.workspaceId ?? "unknown";
    const agentId = asString(input.payload.agentId) ?? "unknown";
    const handle = asString(input.payload.handle) ?? "unknown";
    const dashboardPath = asString(input.payload.dashboardPath) ?? `/conversations/${conversationId}`;
    await this.dispatcher.dispatch({
      kind: "approval",
      workspaceId,
      conversationId,
      agentId,
      handle,
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
