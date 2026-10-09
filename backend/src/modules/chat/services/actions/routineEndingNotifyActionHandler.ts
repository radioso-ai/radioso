import {
  asString,
  routineEndingNotificationFromAction,
  type OperatorNotificationDispatcher,
  type RoutineEndingNotificationSubject,
} from "../../../operatorNotifications/public.js";
import type { RoutineEndingNoticeAction } from "../operatorNoticeAction.js";
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
    routineId: string | null;
    conversationId: string;
  }): Promise<RoutineEndingNotificationSubject>;
}

/**
 * Dispatches the operator notice a routine ending queued. One handler serves every row of
 * `ROUTINE_ENDING_NOTICE_ACTIONS` (`handoff.notify`, `completion.notify`), registered once per
 * row. The row fixes the notification kind and the reason a payload without one reports, so no
 * sink branches on the action type, and a delivery never changes who owns the conversation —
 * that was settled when the turn committed.
 */
export class RoutineEndingNotifyActionHandler implements ActionHandler {
  private readonly ending: Pick<RoutineEndingNoticeAction, "notificationKind" | "reason">;
  private readonly dispatcher: Pick<OperatorNotificationDispatcher, "dispatch">;
  private readonly subjects: RoutineEndingNotificationSubjectResolver;

  constructor(options: {
    ending: Pick<RoutineEndingNoticeAction, "notificationKind" | "reason">;
    dispatcher: Pick<OperatorNotificationDispatcher, "dispatch">;
    subjects: RoutineEndingNotificationSubjectResolver;
  }) {
    this.ending = options.ending;
    this.dispatcher = options.dispatcher;
    this.subjects = options.subjects;
  }

  async handle(input: { payload: Record<string, unknown>; context: ActionHandlerContext }): Promise<void> {
    // The queued row is the trusted source for its workspace and conversation; `routineId` is
    // payload data, but the resolver scopes it through that conversation's agent.
    const conversationId = input.context.conversationId ?? "unknown";
    const workspaceId = input.context.workspaceId ?? "unknown";
    const routineId = asString(input.payload.routineId);
    const subject = input.context.workspaceId && input.context.conversationId
      ? await this.subjects.resolve({ workspaceId, routineId, conversationId })
      : null;
    const notification = routineEndingNotificationFromAction({
      kind: this.ending.notificationKind,
      payload: input.payload,
      ids: { conversationId, workspaceId, agentId: subject?.agentId ?? null },
      fallback: { reason: this.ending.reason },
      ...(subject ? { subject } : {}),
    });
    await this.dispatcher.dispatch(notification, {
      requestId: input.context.requestId,
      workspaceId: input.context.workspaceId,
      accountId: input.context.accountId,
      conversationId: input.context.conversationId,
      idempotencyKey: input.context.idempotencyKey,
      attempt: input.context.attempt,
      // Read off the queued row, never re-read from the routine: the draft may have changed since
      // the turn that reached this ending, and the row records what that turn's routine named.
      ...(input.context.skillName ? { skillName: input.context.skillName } : {}),
    });
  }
}
