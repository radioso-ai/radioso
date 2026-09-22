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
 * What became of the tool call a turn carried. `not_started` means the call
 * reached the turn but never reached the activator: another routine was active
 * or suspended and the existing interruption/approval rules kept the turn.
 */
export type RoutineInvocationOutcome = "started" | "reentered" | "declined" | "not_started" | "unknown_tool";

/** Reported only on an invocation turn, beside the routine state the turn left. */
export interface RoutineInvocationReport {
  toolName: string;
  outcome: RoutineInvocationOutcome;
}

/**
 * Describes a saved routine state for the turn that produced it, over the
 * compiled routines that turn could see. The turn provider returns one beside
 * its activator so the host can report without knowing routine internals.
 */
export interface RoutineTurnReporter {
  describe(input: { state: RoutineState; awaitingDecision?: boolean }): RoutineTurnState | null;
  /**
   * The routine a direct invocation named when this turn's activator declined to
   * admit it (already completed under `once_per_conversation`), reported as
   * completed so the caller learns why nothing started; null on any other turn.
   */
  describeDeclined(): RoutineTurnState | null;
  /** The tool call this turn carried and its outcome; null on a message turn. */
  describeInvocation(): RoutineInvocationReport | null;
}
