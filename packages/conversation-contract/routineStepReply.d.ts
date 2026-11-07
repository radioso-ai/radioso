// What a routine step's reply is written from, and the host ports that write it.
import type {
  ConversationRoutineRunEffects,
  PendingRenderableTurn,
  RenderableTurn,
  RoutineSlotSchema,
  RoutineStep,
  SteeringRule,
  TurnContext,
} from "./index.js";

/**
 * Renders the reply for the routine's current step. The host implements this with
 * the Radioso composer (the projected step steering is passed in), so the pure
 * engine owns graph mechanics and the host owns generation/presentation. It is told
 * only what it needs to write the message — the step and its projected steering for
 * this turn, and on a re-ask what the step still lacks — not the graph topology or
 * slot values.
 *
 * The rules play two roles (#1351): a `source: "routine"` rule is the step's own
 * instruction and controls what the message asks for or does; every other rule
 * (authored directives) is subordinate guidance that shapes how it is said and
 * never replaces the step's question or action.
 */
export interface ConversationRoutineStepRenderer {
  render(input: RoutineStepReplyInput): Promise<RenderableTurn>;
  /**
   * Decides the reply without generating it: no model call happens until the returned
   * reply's `render()` or `stream()`, and `prepare(input).render()` produces what
   * `render(input)` would. Optional; a runner without it renders with `render`.
   */
  prepare?(input: RoutineStepReplyInput): PendingRenderableTurn;
}

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
   * True when {@link ConversationRoutineOperatorReach} reports that this turn's effects cannot
   * notify the team. The reply does not claim the team was told, whatever the step instruction
   * says, and keeps the rest of what the step says. A hand-off's message ignores it: that wording
   * makes no such claim.
   */
  operatorsUnreachable?: boolean;
}

/**
 * The effects of a routine turn the host weighs when {@link ConversationRoutineOperatorReach} asks
 * whether they can notify the team. A skill can queue its own effect, so the skills a turn ran
 * count beside the actions it emitted.
 */
export type RoutineOperatorBoundEffects = Pick<
  ConversationRoutineRunEffects,
  "actions" | "terminal" | "skillsWithExternalEffects"
>;

/**
 * Asked before a routine turn's reply is written, on a turn that emitted an action, ran a skill
 * that may act outside the conversation, or ended on an operator notice: can what the turn did
 * notify the team? Delivery happens later, in a worker, and the reply must not promise what cannot
 * happen. Only the host knows which effects address operators and who could receive them, so the
 * answer is all the runner learns. A turn that parks awaiting a person's decision is not asked: a
 * person already has it. A runner with no port checks nothing. A rejection fails the turn, as any
 * port's does, so a host answers `true` when it cannot tell.
 */
export interface ConversationRoutineOperatorReach {
  canReachOperators(effects: RoutineOperatorBoundEffects): Promise<boolean>;
}

/**
 * Present when the turn renders the same chat step the user was answering, because
 * their reply did not satisfy it. Absent on a step's first rendering, including the
 * routine's activation turn.
 */
export interface RoutineStepReask {
  /**
   * The step's collected slots that are still unfilled, plus any whose value this turn was
   * rejected for not fitting its declared type. Schema only, never values.
   */
  missingSlots: RoutineSlotSchema[];
  /**
   * True once the step has been asked again more times in a row than the runner's re-ask
   * limit allows (#1376): the reply should ask differently rather than repeat the question.
   */
  exhausted?: boolean;
}
