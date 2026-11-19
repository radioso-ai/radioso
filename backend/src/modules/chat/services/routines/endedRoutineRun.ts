import type { Routine, RoutineState } from "@radioso/conversation-contract";

import { endedRunValues } from "../../../routines/public.js";
import { ROUTINE_EVENT_OUTCOMES, type RoutineEventOutcome } from "../../../../shared/domain/workspaceEvents.js";

/** A routine run saved as ended, with the values an automation acts on (#1851). */
export interface EndedRoutineRun {
  routineId: string;
  executionId: string | null;
  outcome: RoutineEventOutcome;
  values: Record<string, unknown>;
  sensitiveSlotKeys: string[];
}

const outcomeOf = (state: RoutineState): RoutineEventOutcome => {
  const kind = state.metadata?.terminalKind;
  return ROUTINE_EVENT_OUTCOMES.find((outcome) => outcome === kind) ?? "complete";
};

/**
 * A save's `ending`, read when the routine-state transition is captured: present when the saved run
 * has ended and its routine is among the turn's `routines`, which hold the slots and their
 * sensitivity. A visitor's later correction to an ended run saves it as ended again, with the
 * corrected values.
 */
export const endedRoutineRunField = (
  routines: readonly Routine[] | undefined,
  state: RoutineState,
): { ending?: EndedRoutineRun } => {
  if (state.status !== "completed") return {};
  const routine = routines?.find((candidate) => candidate.id === state.routineId);
  if (!routine) return {};
  return {
    ending: {
      routineId: state.routineId,
      executionId: state.executionId ?? null,
      outcome: outcomeOf(state),
      ...endedRunValues(routine, state.variables),
    },
  };
};
