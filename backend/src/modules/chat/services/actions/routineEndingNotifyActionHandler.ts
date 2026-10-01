import {
  asString,
  routineEndingNotificationFromAction,
  type OperatorNotificationDispatcher,
  type RoutineEndingNotificationSubject,
  type RoutineEndingOperatorNotification,
} from "../../../operatorNotifications/public.js";
import type { ActionHandler, ActionHandlerContext } from "./actionDispatcher.js";

/**
 * Resolves what a routine-ending notice shows next to the ids it carries: the agent and routine
 * names, and the facts already stored about the conversation. Anything the lookup cannot find
 * (an agent or routine deleted after the notice was queued) resolves to `null`; the notice must
 * still deliver, so implementations never throw for a missing row.
 */
export interface RoutineEndingNotificationSubjectResolver {
  resolve(input: {
    workspaceId: string;
    agentId: string;
    routineId: string | null;
    conversationId: string;
  }): Promise<RoutineEndingNotificationSubject>;
}

/**
 * Dispatches the operator notice a routine ending queued. One handler serves both action types:
 * `handoff.notify` (registered with kind `handoff`) and `completion.notify` (kind `completion`).
 * The kind is fixed at registration, so no sink branches on the action type, and a delivery
 * never changes who owns the conversation — that was settled when the turn committed.
 */
export class RoutineEndingNotifyActionHandler implements ActionHandler {
  private readonly kind: RoutineEndingOperatorNotification["kind"];
  private readonly dispatcher: Pick<OperatorNotificationDispatcher, "dispatch">;
  private readonly subjects?: RoutineEndingNotificationSubjectResolver;

  constructor(options: {
    kind: RoutineEndingOperatorNotification["kind"];
    dispatcher: Pick<OperatorNotificationDispatcher, "dispatch">;
    subjects?: RoutineEndingNotificationSubjectResolver;
  }) {
    this.kind = options.kind;
    this.dispatcher = options.dispatcher;
    this.subjects = options.subjects;
  }

  async handle(input: { payload: Record<string, unknown>; context: ActionHandlerContext }): Promise<void> {
    const conversationId = asString(input.payload.conversationId) ?? input.context.conversationId ?? "unknown";
    const workspaceId = asString(input.payload.workspaceId) ?? input.context.workspaceId ?? "unknown";
    const agentId = asString(input.payload.agentId) ?? "unknown";
    const routineId = asString(input.payload.routineId);
    const subject = await this.subjects?.resolve({ workspaceId, agentId, routineId, conversationId });
    const notification = routineEndingNotificationFromAction({
      kind: this.kind,
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
