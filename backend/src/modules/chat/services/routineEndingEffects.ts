import type { RoutineActionRequest, RoutineOperatorNotice } from "@radioso/conversation-contract";

import {
  operatorNoticeActionPayload,
  routineHandoffOwnership,
  type RoutineHandoffEffect,
} from "./handoffOwnership.js";
import type { PreparedSession } from "./chatSessionPreparer.js";
import { COMPLETION_NOTIFY_ACTION_TYPE, HANDOFF_NOTIFY_ACTION_TYPE } from "./routines/contactRoutine.js";

/** The routine-ending effects a turn reports, whichever path (routine, coverage, rendered) ran it. */
interface RoutineEndingTurnEffects {
  handoff?: RoutineHandoffEffect;
  operatorNotice?: RoutineOperatorNotice;
  actions?: RoutineActionRequest[];
}

/**
 * The action an ending's notice is queued as, by the kind of the ending. A hand-off keeps
 * `handoff.notify`, so outbox rows queued before completions could notify keep dispatching.
 */
const NOTIFY_ACTION_BY_TERMINAL_KIND: Record<RoutineOperatorNotice["terminalKind"], { type: string; reason: string }> = {
  handoff: { type: HANDOFF_NOTIFY_ACTION_TYPE, reason: "routine_handoff" },
  complete: { type: COMPLETION_NOTIFY_ACTION_TYPE, reason: "routine_completed" },
};

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
  const action = NOTIFY_ACTION_BY_TERMINAL_KIND[input.notice.terminalKind];
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
