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

/** Narrow conversation lookup for the approval's agent (a `ConversationRepository` satisfies it). */
interface ApprovalRequestConversationLookup {
  findByIdAndWorkspaceId(conversationId: string, workspaceId: string): Promise<{ agentId: string | null } | null>;
}

export class ApprovalRequestActionHandler implements ActionHandler {
  constructor(
    private readonly dispatcher: Pick<OperatorNotificationDispatcher, "dispatch">,
    private readonly conversations: ApprovalRequestConversationLookup,
  ) {}

  async handle(input: { payload: Record<string, unknown>; context: ActionHandlerContext }): Promise<void> {
    // The queued row is the trusted source for its workspace and conversation, and that
    // conversation for its agent. Payload copies of these ids are ignored: a payload can carry
    // visitor-filled variables under any key.
    const contextWorkspaceId = input.context.workspaceId;
    const contextConversationId = input.context.conversationId;
    const conversation = contextWorkspaceId && contextConversationId
      ? await this.conversations.findByIdAndWorkspaceId(contextConversationId, contextWorkspaceId)
      : null;
    const conversationId = contextConversationId ?? "unknown";
    const workspaceId = contextWorkspaceId ?? "unknown";
    const agentId = conversation?.agentId ?? "unknown";
    const handle = asString(input.payload.handle) ?? "unknown";
    await this.dispatcher.dispatch({
      kind: "approval",
      workspaceId,
      conversationId,
      agentId,
      handle,
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
