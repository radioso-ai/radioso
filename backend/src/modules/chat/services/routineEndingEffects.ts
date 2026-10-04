import type { RoutineActionRequest, RoutineOperatorNoticeEffect } from "@radioso/conversation-contract";

import { routineHandoffOwnership, type RoutineHandoffEffect } from "./handoffOwnership.js";
import { operatorNoticeActionPayload, routineEndingNoticeAction } from "./operatorNoticeAction.js";
import type { PreparedSession } from "./chatSessionPreparer.js";

/** The routine-ending effects a turn reports, whichever path (routine, coverage, rendered) ran it. */
interface RoutineEndingTurnEffects {
  handoff?: RoutineHandoffEffect;
  operatorNotice?: RoutineOperatorNoticeEffect;
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
  notice: RoutineOperatorNoticeEffect;
}): RoutineActionRequest => {
  const action = routineEndingNoticeAction(input.notice.terminalKind);
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
 * The notice a turn's routine ending sends operators. Every hand-off notifies, so a hand-off
 * whose runner reported no `operatorNotice` (one that predates notices, or a visitor stuck past
 * the re-ask limit (#1384), which is never authored and so never carries one) still sends the
 * default one, carrying the hand-off's own terminal kind and what it collected; otherwise the
 * reported notice stands. Exported so a Test Chat preview applies the same rule.
 */
export const operatorNoticeForTurn = (
  turn: Pick<RoutineEndingTurnEffects, "handoff" | "operatorNotice">,
): RoutineOperatorNoticeEffect | undefined => {
  if (turn.operatorNotice || !turn.handoff) {
    return turn.operatorNotice;
  }
  return {
    routineId: turn.handoff.routineId,
    stepId: turn.handoff.stepId,
    terminalKind: turn.handoff.terminalKind,
    ...(turn.handoff.collected ? { collected: turn.handoff.collected } : {}),
  };
};

/**
 * What a routine ending does beyond the reply, in one place for every chat path. The two
 * effects are independent: `handoff` moves the conversation to a person, the operator notice
 * ({@link operatorNoticeForTurn}) is queued next to the turn's own actions. A completion with
 * a notice notifies and leaves ownership alone; a hand-off does both.
 */
export const routineEndingEffectsForTurn = (input: {
  session: PreparedSession;
  workspaceId: string;
  turn: RoutineEndingTurnEffects;
}): {
  ownershipHandoff: ReturnType<typeof routineHandoffOwnership> | null;
  actions?: RoutineActionRequest[];
} => {
  const { handoff, actions } = input.turn;
  const operatorNotice = operatorNoticeForTurn(input.turn);
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
