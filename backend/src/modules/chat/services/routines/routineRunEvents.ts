import type { Routine, RoutineState } from "@radioso/conversation-contract";

import { endedRunValues, routineSlotSaves, type RoutineSlotSave } from "../../../routines/public.js";
import { ROUTINE_EVENT_OUTCOMES, type RoutineEventOutcome } from "../../../../shared/domain/workspaceEventLog.js";

/**
 * What a saved routine run hands the workspace event log (#1851), read when the routine-state
 * transition is captured, from the turn's routines, which hold the slots and their sensitivity.
 */

/** A routine run saved as ended, with the values an automation acts on. */
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
 * A save's `ending`: present when the saved run has ended and its routine is among the turn's
 * `routines`. A visitor's later correction to an ended run saves it as ended again, with the
 * corrected values.
 */
const endingOf = (routine: Routine, state: RoutineState): EndedRoutineRun | undefined =>
  state.status === "completed"
    ? {
        routineId: state.routineId,
        executionId: state.executionId ?? null,
        outcome: outcomeOf(state),
        ...endedRunValues(routine, state.variables),
      }
    : undefined;

/**
 * The fields a save transition carries for the event log: the run's `ending` when it ended, and the
 * routine's `declaredSlotKeys` when it declares any, so an action the run queued this turn reaches
 * the log with the routine's slots only, never a tool output or a stray key. `slotSaves` are the
 * slot values the ended run saves to attributes (#1884), present when it saves any; `endedBefore`
 * is the run as it had already ended, when this save corrects it.
 */
export const routineRunEventFields = (
  routines: readonly Routine[] | undefined,
  state: RoutineState,
  endedBefore?: RoutineState,
): { ending?: EndedRoutineRun; declaredSlotKeys?: string[]; slotSaves?: RoutineSlotSave[] } => {
  const routine = routines?.find((candidate) => candidate.id === state.routineId);
  if (!routine) return {};
  const ending = endingOf(routine, state);
  const declaredSlotKeys = (routine.slots ?? []).map((slot) => slot.key);
  const slotSaves = routineSlotSaves(routine, state, endedBefore);
  return {
    ...(ending ? { ending } : {}),
    ...(declaredSlotKeys.length > 0 ? { declaredSlotKeys } : {}),
    ...(slotSaves.length > 0 ? { slotSaves } : {}),
  };
};
