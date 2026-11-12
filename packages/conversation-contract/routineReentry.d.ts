// Whether a routine that already ended in a conversation starts again.
import type { RoutineState, TurnContext } from "./index.js";

/**
 * Structured decision for a completed routine whose reentry mode is `semantic` (issue #746):
 * - `suppress`: leave the completed routine suppressed (the safe default for any non-semantic
 *   routine the gate is asked about, and for an unrelated message).
 * - `resume_existing`: re-open the same instance, keeping its captured variables.
 * - `start_new`: run the routine again from scratch, discarding the prior captured variables.
 */
export type RoutineReentryDecision =
  | { kind: "suppress" }
  | { kind: "resume_existing" }
  | { kind: "start_new" };

/**
 * Host port that decides whether a completed `semantic`-reentry routine should re-activate.
 * The host owns routine resolution + the model-driven decision; it returns `suppress` (no
 * model call) for any routine that is not in semantic mode, so the gate is inert unless an
 * author opted into it.
 */
export interface ConversationRoutineReentryGate {
  decide(input: { turn: TurnContext; completedState: RoutineState }): Promise<RoutineReentryDecision>;
}
