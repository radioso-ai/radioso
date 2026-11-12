// Changing a value a routine run held after the run ended, without running it again.
import type { RoutineConsent, RoutineSlotSchema, RoutineState, TurnContext } from "./index.js";

/**
 * A detected post-completion slot correction (issue #746): the routine's declared slot
 * schema and consents, plus the slot the visitor wants to change and the proposed raw value.
 * The host resolves the routine (it owns the catalog) and runs model-driven, multilingual
 * detection; the engine then deterministically verifies via `verifySlotCorrection` before
 * persisting.
 */
export interface RoutineSlotCorrectionCandidate {
  slots: RoutineSlotSchema[];
  /**
   * The routine's consents, none when it has none (#1544). A slot one covers takes a value only
   * while the routine runs, past its consent, so the engine never corrects it, whatever runner
   * ran the routine.
   */
  consents: RoutineConsent[];
  slotKey: string;
  rawValue: string;
}

/**
 * Why a message after a routine ended is not a correction to it (#1714). Each reason names a
 * decision, never a value, so a host may record it on a trace:
 * - `unknown_routine`: the completed routine is not among this turn's routines.
 * - `no_mutable_slot`: the routine marks no slot editable after completion.
 * - `not_held`: the run ended holding no value in any editable slot.
 * - `already_sent`: the run already sent what it held outside the conversation — its ending
 *   notified operators, handed off, or exported, or it ran a tool, action, or approval step — and
 *   a correction would reach none of them.
 * - `new_request`: the message asks for something new rather than changing a held value.
 * - `not_a_correction`: anything else, an unreadable decision included.
 */
export type RoutineSlotCorrectionSkipReason =
  | "unknown_routine"
  | "no_mutable_slot"
  | "not_held"
  | "already_sent"
  | "new_request"
  | "not_a_correction";

/** What the correction port read from a message after a routine ended: a correction, or why not. */
export type RoutineSlotCorrectionDetection =
  | ({ kind: "correction" } & RoutineSlotCorrectionCandidate)
  | { kind: "none"; reason: RoutineSlotCorrectionSkipReason };

/**
 * Host port for correcting a value captured by a routine that already completed, without
 * rerunning it. `detect` offers a correction only to an editable slot the completed run holds,
 * and only while nothing the run held has left the conversation; otherwise it returns `none`
 * with the reason, and the turn goes on to reentry and activation. The engine re-checks the
 * slot is held and the value fits before it keeps anything. `confirm` produces the user-facing
 * reply — copy comes from the model, never hard-coded in the engine.
 */
export interface ConversationRoutineSlotCorrection {
  detect(input: { turn: TurnContext; completedState: RoutineState }): Promise<RoutineSlotCorrectionDetection>;
  confirm(input: {
    turn: TurnContext;
    routineId: string;
    slotKey: string;
    value: string | number | boolean;
  }): Promise<string>;
  /**
   * Reply when a detected correction's new value fails the slot's declared type — asks the
   * visitor for a valid value. Copy comes from the model; the engine persists nothing.
   */
  rejectInvalid(input: { turn: TurnContext; routineId: string; slotKey: string }): Promise<string>;
}
