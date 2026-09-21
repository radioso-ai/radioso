import type { RoutineSlotType, RoutineState } from "@radioso/conversation-contract";

export type RoutineTurnStatus =
  | "active"
  | "waiting_for_input"
  | "waiting_for_approval"
  | "completed"
  | "abandoned";

/** One declared slot a calling agent can still supply, described from the routine definition. */
export interface RoutinePendingInput {
  key: string;
  type: RoutineSlotType;
  required: boolean;
  description?: string;
}

/**
 * Where a turn left the routine it touched, in terms a calling agent can act
 * on: what it is, whether it needs input, a decision, or is done, and every
 * slot still open. Routine data that the chat module forwards in its reply
 * envelope without interpreting it.
 */
export interface RoutineTurnState {
  /** The tool name the routine is exposed under, when it has one. */
  toolName?: string;
  name: string;
  status: RoutineTurnStatus;
  /** Every unfilled required slot plus the current step's unfilled optional slots. */
  pendingInput: RoutinePendingInput[];
}

/**
 * Describes a saved routine state for the turn that produced it, over the
 * compiled routines that turn could see. The turn provider returns one beside
 * its activator so the host can report without knowing routine internals.
 */
export interface RoutineTurnReporter {
  describe(input: { state: RoutineState; awaitingDecision?: boolean }): RoutineTurnState | null;
}
