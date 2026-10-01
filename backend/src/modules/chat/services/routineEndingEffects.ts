import type { RoutineActionRequest } from "@radioso/conversation-contract";

import {
  routineHandoffNotifyAction,
  routineHandoffOwnership,
  type RoutineHandoffEffect,
} from "./handoffOwnership.js";
import type { PreparedSession } from "./chatSessionPreparer.js";

/** The routine-ending effects a turn reports, whichever path (routine, coverage, rendered) ran it. */
export interface RoutineEndingTurnEffects {
  handoff?: RoutineHandoffEffect;
  actions?: RoutineActionRequest[];
}

/**
 * What a routine ending does beyond the reply, in one place for every chat path: the ownership
 * change a hand-off makes, and the operator notification it queues alongside the turn's own
 * actions.
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
  if (!handoff) {
    return { ownershipHandoff: null, actions };
  }
  return {
    ownershipHandoff: routineHandoffOwnership(handoff),
    actions: [
      ...(actions ?? []),
      routineHandoffNotifyAction({ session: input.session, workspaceId: input.workspaceId, handoff }),
    ],
  };
};
