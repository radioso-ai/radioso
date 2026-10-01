import type { RoutineActionRequest, RoutineOperatorNotice } from "@radioso/conversation-contract";

import { routineHandoffOwnership, type RoutineHandoffEffect } from "./handoffOwnership.js";
import { operatorNoticeActionPayload, ROUTINE_ENDING_NOTICE_ACTIONS } from "./operatorNoticeAction.js";
import type { PreparedSession } from "./chatSessionPreparer.js";

/** The routine-ending effects a turn reports, whichever path (routine, coverage, rendered) ran it. */
interface RoutineEndingTurnEffects {
  handoff?: RoutineHandoffEffect;
  operatorNotice?: RoutineOperatorNotice;
  actions?: RoutineActionRequest[];
}

/**
 * Builds the action an ending's operator notice is queued as. Exported so a Test Chat turn —
 * whose actions are suppressed rather than dispatched — can preview the identical payload.
 */
export const buildRoutineEndingNotifyAction = (input: {
  conversationId: string;
  workspaceId: string;
  agentId: string;
  userMessageId: string;
  notice: RoutineOperatorNotice;
}): RoutineActionRequest => {
  const action = ROUTINE_ENDING_NOTICE_ACTIONS[input.notice.terminalKind];
  return {
    type: action.type,
    payload: operatorNoticeActionPayload({
      conversationId: input.conversationId,
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      userMessageId: input.userMessageId,
      reason: action.reason,
      routineId: input.notice.routineId,
      stepId: input.notice.stepId,
      collected: input.notice.collected,
      notice: input.notice,
    }),
  };
};

/**
 * What a routine ending does beyond the reply, in one place for every chat path. The two
 * effects are independent: `handoff` moves the conversation to a person, `operatorNotice`
 * queues the notice to operators next to the turn's own actions. A completion with a notice
 * notifies and leaves ownership alone; a hand-off does both.
 */
export const routineEndingEffectsForTurn = (input: {
  session: PreparedSession;
  workspaceId: string;
  turn: RoutineEndingTurnEffects;
}): {
  ownershipHandoff: ReturnType<typeof routineHandoffOwnership> | null;
  actions?: RoutineActionRequest[];
} => {
  const { handoff, operatorNotice, actions } = input.turn;
  return {
    ownershipHandoff: handoff ? routineHandoffOwnership(handoff) : null,
    actions: operatorNotice
      ? [
          ...(actions ?? []),
          buildRoutineEndingNotifyAction({
            conversationId: input.session.conversation.id,
            workspaceId: input.workspaceId,
            agentId: input.session.agent.id,
            userMessageId: input.session.userMessage.id,
            notice: operatorNotice,
          }),
        ]
      : actions,
  };
};
