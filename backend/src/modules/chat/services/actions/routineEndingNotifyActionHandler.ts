import {
  asString,
  routineEndingNotificationFromAction,
  type OperatorNotificationDispatcher,
  type RoutineEndingNotificationSubject,
} from "../../../operatorNotifications/public.js";
import type { RoutineEndingNoticeAction } from "../operatorNoticeAction.js";
import type { ActionHandler, ActionHandlerContext } from "./actionDispatcher.js";
import type { RoutineEndingNoticeSummaryGenerator } from "./routineEndingNoticeSummary.js";
import { traceOperation } from "../../../../shared/observability/tracing/operations.js";
import { ROUTINE_NOTICE_SUMMARY_TIMEOUT_MS } from "./routineEndingNoticeSummary.js";

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
  private readonly summaryGenerator?: RoutineEndingNoticeSummaryGenerator;

  constructor(options: {
    ending: Pick<RoutineEndingNoticeAction, "notificationKind" | "reason">;
    dispatcher: Pick<OperatorNotificationDispatcher, "dispatch">;
    subjects: RoutineEndingNotificationSubjectResolver;
    summaryGenerator?: RoutineEndingNoticeSummaryGenerator;
    logger?: { warn(payload: Record<string, unknown>, message: string): void };
  }) {
    this.ending = options.ending;
    this.dispatcher = options.dispatcher;
    this.subjects = options.subjects;
    this.summaryGenerator = options.summaryGenerator;
    this.logger = options.logger;
  }
  private readonly logger?: { warn(payload: Record<string, unknown>, message: string): void };

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
    let summaryOutcome: "generated" | "skipped" | "failed" = "skipped";
    const endingMessageId = asString(input.payload.userMessageId);
    const summary = notification.notice?.includeAiSummary && this.summaryGenerator && endingMessageId
      ? await traceOperation({
          name: "routine.operator_notice_summary",
          attributes: { "radioso.workspace_id": workspaceId, "radioso.conversation_id": conversationId },
          resultAttributes: () => ({ "routine.operator_notice_summary.outcome": summaryOutcome }),
          run: async () => {
            try {
              const timedOut = Symbol("timed_out");
              let timeout: ReturnType<typeof setTimeout> | undefined;
              const generated = await Promise.race<string | null | typeof timedOut>([
                this.summaryGenerator!.generate({
                workspaceId,
                accountId: input.context.accountId,
                conversationId,
                endingMessageId,
                routineStartMessageId: asString(input.payload.routineStartMessageId) ?? undefined,
                outputLanguage: asString(input.payload.responseLanguage) ?? "the conversation's language",
                collected: notification.collected ?? {},
                }),
                new Promise<typeof timedOut>((resolve) => { timeout = setTimeout(() => resolve(timedOut), ROUTINE_NOTICE_SUMMARY_TIMEOUT_MS); }),
              ]);
              if (timeout) clearTimeout(timeout);
              if (generated === timedOut) {
                summaryOutcome = "failed";
                this.logger?.warn({ event: "routine_operator_notice_summary_failed", operation: "routine_operator_notice_summary", errorType: "timeout" }, "Routine operator notice summary timed out");
                return null;
              }
              summaryOutcome = generated ? "generated" : "skipped";
              return generated;
            } catch (error) {
              summaryOutcome = "failed";
              this.logger?.warn({ event: "routine_operator_notice_summary_failed", operation: "routine_operator_notice_summary", errorType: error instanceof Error ? error.name : typeof error }, "Routine operator notice summary failed");
              return null;
            }
          },
        })
      : null;
    await this.dispatcher.dispatch(summary ? { ...notification, aiSummary: summary } : notification, {
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
