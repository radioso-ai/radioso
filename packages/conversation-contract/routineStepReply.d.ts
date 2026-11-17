// What a routine step's reply is written from: the step and its steering, the turn, and what the
// runner reports beside them — a re-ask, a stuck hand-off, or what the run did before its ending.
import type { RoutineContextRenderer, SteeringRule, TurnContext } from "./index.js";
import type { RoutineStep, RoutineStepReask } from "./routineGraph.js";
import type { RoutineSkillOutcomeStatus } from "./skillOutcome.js";

/** What a routine step's reply is written from. */
export interface RoutineStepReplyInput {
  step: RoutineStep;
  steering: SteeringRule[];
  turn: TurnContext;
  reask?: RoutineStepReask;
  /**
   * True when the runner ends the routine on `step` because the visitor stayed stuck on it
   * past the re-ask limit, and a person takes the conversation over (#1384). The reply tells
   * the visitor a person continues from here; it neither asks the step's question nor
   * follows its instruction, so `steering` is empty and `reask` absent.
   */
  stuckHandoff?: boolean;
  /** {@link RoutineContextRenderer.evidence} of the context variables the step references; absent when none carries any. */
  contextEvidence?: readonly string[];
  /**
   * What the run did before the ending `step` is (#1820). The runner sets it exactly when `step`
   * is a `terminal` the run reached; a chat step's reply and a stuck hand-off carry none.
   */
  ending?: RoutineEndingRun;
}

/**
 * What a run did before its ending, as the runner recorded it (#1820). An ending's text is
 * written for the path its author meant the run to take, and the run may not have taken it: a
 * search before the ending can find nothing, and an ending can promise follow-up that nobody
 * outside the conversation is told about. Names and outcome statuses only, never a step's
 * outputs or the values the run holds.
 */
export interface RoutineEndingRun {
  /**
   * Whether the run passes its request to someone outside the conversation: the ending hands the
   * conversation to a person, notifies operators, or fires the completion export, or the run
   * emitted an action, passed an approval step, or ran a tool step that may act outside the
   * conversation. A tool step an earlier turn ran counts, since its outcome is not kept.
   */
  requestPassedOn: boolean;
  /**
   * The tool steps the run ran on the ending's turn, in order, with the status each reported:
   * `empty` from a search that found nothing, `failed` from a tool that could not run. A tool
   * step an earlier turn ran is not listed; the run's state keeps no step outcomes.
   */
  skillOutcomes: RoutineEndingSkillOutcome[];
}

export interface RoutineEndingSkillOutcome {
  skillName: string;
  status: RoutineSkillOutcomeStatus;
}
