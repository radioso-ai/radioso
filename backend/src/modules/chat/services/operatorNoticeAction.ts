import type { RoutineOperatorNoticeEffect, RoutineOperatorNoticeTemplate } from "@radioso/conversation-contract";

import type { RoutineEndingOperatorNotification } from "../../operatorNotifications/public.js";
import { COMPLETION_NOTIFY_ACTION_TYPE, HANDOFF_NOTIFY_ACTION_TYPE } from "./routines/contactRoutine.js";

/** How the notice of one kind of routine ending travels from the turn to the operators. */
export interface RoutineEndingNoticeAction {
  /** The action type the notice is queued as. */
  type: string;
  /** The reason code its payload carries. */
  reason: string;
  /** The notification kind the dispatch handler delivers it as. */
  notificationKind: RoutineEndingOperatorNotification["kind"];
}

/**
 * One row per kind of routine ending that notifies operators: the producer queues the row's
 * action, composition registers one dispatch handler per row, and a Test Chat preview renders
 * the row's notification kind. A hand-off keeps `handoff.notify`, so outbox rows queued before
 * completions could notify keep dispatching.
 */
export const ROUTINE_ENDING_NOTICE_ACTIONS: Readonly<Record<RoutineOperatorNoticeEffect["terminalKind"], RoutineEndingNoticeAction>> = {
  handoff: { type: HANDOFF_NOTIFY_ACTION_TYPE, reason: "routine_handoff", notificationKind: "handoff" },
  complete: { type: COMPLETION_NOTIFY_ACTION_TYPE, reason: "routine_completed", notificationKind: "completion" },
};

/**
 * The payload every operator-notice action carries (`handoff.notify`, `completion.notify`): ids,
 * the reason code, the routine's declared slot values as-is, and the authored notice text when
 * the ending has some. One builder, so the two action types cannot drift apart.
 */
export const operatorNoticeActionPayload = (input: {
  conversationId: string;
  workspaceId: string;
  agentId: string;
  userMessageId: string;
  reason: string;
  routineId?: string;
  stepId?: string;
  /** The routine's declared slot values, forwarded to the operator notice as-is. */
  collected?: Record<string, unknown>;
  notice?: RoutineOperatorNoticeTemplate;
}): Record<string, unknown> => ({
  conversationId: input.conversationId,
  workspaceId: input.workspaceId,
  agentId: input.agentId,
  userMessageId: input.userMessageId,
  reason: input.reason,
  routineId: input.routineId,
  stepId: input.stepId,
  ...(input.collected ? { collected: input.collected } : {}),
  ...(input.notice?.subject || input.notice?.intro ? { notice: authoredNoticeText(input.notice) } : {}),
});

/** Only the text the author wrote; an absent field means the default for the ending's kind. */
const authoredNoticeText = (notice: RoutineOperatorNoticeTemplate): RoutineOperatorNoticeTemplate => ({
  ...(notice.subject ? { subject: notice.subject } : {}),
  ...(notice.intro ? { intro: notice.intro } : {}),
});
