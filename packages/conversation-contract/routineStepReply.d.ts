// What a routine step's reply is written from: the step and its steering, the turn, and what the
// runner reports beside them — a re-ask, a stuck hand-off, or what the run did before its ending —
// and the host's port for the replies it grounds on retrieved evidence.
import type { RoutineContextRenderer, SteeringRule, TurnContext } from "./index.js";
import type { PendingRenderableTurn, RenderableTurn } from "./renderableTurn.js";
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

/** Renders a grounded answer for a routine step, or null when the step is not groundable. */
export interface RoutineGroundedAnswerRenderer {
  render(input: RoutineGroundedAnswerInput): Promise<RenderableTurn | null>;
  /**
   * Decides from the turn's staged context alone whether the step is groundable: null when
   * it is not, otherwise the grounded answer, generated only when asked.
   * `prepare(input)?.render()` produces what `render(input)` would. Optional.
   */
  prepare?(input: RoutineGroundedAnswerInput): PendingRenderableTurn | null;
  /**
   * Metadata the host puts on a step reply it did not ground, read from the staged context alone,
   * so it presents that reply the way it classifies the turn: an ending on a retrieval that found
   * nothing is the turn's retrieval miss (#1820). Optional; absent or undefined adds none.
   */
  stepReplyMetadata?(input: RoutineGroundedAnswerInput): Record<string, unknown> | undefined;
}

/**
 * `ending` is what the run did before an ending (#1820); with nothing retrieved, an ending is
 * not groundable, and with evidence its grounded answer is told the same facts.
 */
export type RoutineGroundedAnswerInput = Pick<RoutineStepReplyInput, "step" | "steering" | "turn" | "ending">;
