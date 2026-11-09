import type { ChatRoutineTurnReporter, ChatRoutineTurnState } from "../../contracts/routineTurnState.js";
import type { CapturedRoutineTransition } from "./deferredRoutineStore.js";

/**
 * A routine a turn reports, and the concrete run it is when the turn knows one. The reply carries
 * `routine`; the run stays in-process (`ChatResponse.routineExecutionId`) and off every wire.
 */
export interface DescribedRoutineTurn {
  routine: ChatRoutineTurnState;
  executionId?: string;
}

/**
 * The routine this turn left, for the reply: the state it saved when it ran one; otherwise the
 * routine the turn named but could not advance — the completed one a direct invocation was
 * declined for (no run: it started none), or the suspended one that kept the turn.
 */
export const describeRoutineTurn = (input: {
  session: { declinedRoutine?: DescribedRoutineTurn; suspendedRoutine?: DescribedRoutineTurn };
  routineStateTransition?: CapturedRoutineTransition | null;
  routineReporter?: ChatRoutineTurnReporter;
  suspended?: boolean;
}): DescribedRoutineTurn | null => {
  if (input.routineReporter && input.routineStateTransition?.kind === "save") {
    const { state } = input.routineStateTransition;
    const routine = input.routineReporter.describe({ state, awaitingDecision: input.suspended === true });
    return routine ? { routine, executionId: state.executionId } : null;
  }
  return input.session.declinedRoutine ?? input.session.suspendedRoutine ?? null;
};
