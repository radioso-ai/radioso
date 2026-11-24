import { isDeepStrictEqual } from "node:util";

import type { Routine, RoutineState, RoutineTerminalKind } from "@radioso/conversation-contract";

import { endedRunTerminalKind, type RoutineSlotSaveScope } from "./domain.js";

/**
 * A slot value an ended run saves to an attribute (#1884). `value` is the run's own, in the slot
 * type's canonical form, never the masked copy that leaves the conversation: a sensitive slot saves
 * only to a Private attribute, which keeps it masked wherever it is read.
 */
export interface RoutineSlotSave {
  slotKey: string;
  contextVariable: string;
  scope: RoutineSlotSaveScope;
  value: unknown;
  sensitive: boolean;
}

/**
 * The endings that save: the authored ones. A run that got stuck or was declined consent reached no
 * terminal its author wrote, and one that was abandoned never ended, so neither leaves facts behind.
 */
const SAVING_TERMINALS: ReadonlySet<RoutineTerminalKind> = new Set(["complete", "handoff"]);

/**
 * What a run saves when it ends: each filled slot that names an attribute, in declared order. Not at
 * slot fill, since a slot can still be corrected and consent may still be missing. A correction to
 * an ended run ends it again: given the run as it had ended (`endedBefore`, the same execution), it
 * saves only the fields the correction changed, so a value the host or a teammate set since for
 * another field stays. How the run ended comes from its path when the store kept no metadata, as
 * the Postgres one keeps a run a correction reads back.
 */
export const routineSlotSaves = (routine: Routine, state: RoutineState, endedBefore?: RoutineState): RoutineSlotSave[] => {
  const terminalKind = endedRunTerminalKind(routine, state);
  if (!terminalKind || !SAVING_TERMINALS.has(terminalKind)) return [];
  const corrected = endedBefore?.status === "completed" && endedBefore.routineId === state.routineId
    && endedBefore.executionId !== undefined && endedBefore.executionId === state.executionId;
  return (routine.slots ?? []).flatMap((slot) => {
    const value = state.variables[slot.key];
    if (!slot.saveTo || value === undefined || value === null) return [];
    if (corrected && isDeepStrictEqual(endedBefore?.variables[slot.key], value)) return [];
    return [{
      slotKey: slot.key,
      contextVariable: slot.saveTo.contextVariable,
      scope: slot.saveTo.scope,
      value,
      sensitive: slot.sensitivity === "sensitive",
    }];
  });
};
