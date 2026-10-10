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
 * One row per *authored* routine ending kind that notifies operators, each queued as its own
 * action type: composition registers exactly one dispatch handler per row (by `type`), and a
 * Test Chat preview renders the row's notification kind. A hand-off keeps `handoff.notify`, so
 * outbox rows queued before completions could notify keep dispatching.
 */
export const ROUTINE_ENDING_NOTICE_ACTIONS: Readonly<Record<"complete" | "handoff", RoutineEndingNoticeAction>> = {
  handoff: { type: HANDOFF_NOTIFY_ACTION_TYPE, reason: "routine_handoff", notificationKind: "handoff" },
  complete: { type: COMPLETION_NOTIFY_ACTION_TYPE, reason: "routine_completed", notificationKind: "completion" },
};

/**
 * The row an ending's notice queues as and is delivered through, for any terminal kind — unlike
 * {@link ROUTINE_ENDING_NOTICE_ACTIONS}, which only the two authored kinds index directly. A
 * visitor stuck past the re-ask limit (#1384) is never authored and so shares the hand-off row's
 * action type and notification kind — ownership moves the same way — but keeps its own reason,
 * so the notice stays distinguishable from an authored hand-off's. It must never get its own
 * registered action type: `handoff.notify` already has exactly one dispatch handler, and a
 * second row sharing that type would collide with it at registration.
 */
export const routineEndingNoticeAction = (
  terminalKind: RoutineOperatorNoticeEffect["terminalKind"],
): RoutineEndingNoticeAction =>
  terminalKind === "stuck"
    ? { ...ROUTINE_ENDING_NOTICE_ACTIONS.handoff, reason: "routine_stuck" }
    : ROUTINE_ENDING_NOTICE_ACTIONS[terminalKind];

/**
 * The payload every operator-notice action carries (`handoff.notify`, `completion.notify`): ids,
 * the reason code, the routine's declared slot values as-is, and the authored notice when the
 * ending has some text or a reply-to field. One builder, so the two action types cannot drift apart.
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
  ...(input.notice?.subject || input.notice?.intro || input.notice?.replyToSlot ? { notice: authoredNotice(input.notice) } : {}),
});

/**
 * Only what the author wrote: the text, where an absent field means the default for the ending's
 * kind, and the field replies go to. It travels with the queued row so delivery replies to the
 * field this turn's routine named, whatever the routine says by the time the row is sent. The
 * notify skill stays off the payload; it rides on the action.
 */
const authoredNotice = (notice: RoutineOperatorNoticeTemplate): RoutineOperatorNoticeTemplate => ({
  ...(notice.subject ? { subject: notice.subject } : {}),
  ...(notice.intro ? { intro: notice.intro } : {}),
  ...(notice.replyToSlot ? { replyToSlot: notice.replyToSlot } : {}),
});
