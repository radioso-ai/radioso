import type {
  ConversationRoutineNextStepSelector,
  ConversationRoutineResumeResult,
  ConversationRoutineRunner,
  ConversationRoutineStepRenderer,
  Routine,
  RoutineState,
  RoutineStep,
  SteeringRule,
  TurnContext,
} from "@radioso/conversation-contract";

/**
 * Projects a step's `action` into a routine steering rule — the keystone that lets
 * a routine step steer the reply through the same steering set authored Directives
 * use. A step with no action (a bare skill step) projects nothing.
 */
const projectStep = (step: RoutineStep): SteeringRule[] =>
  step.action
    ? [{
        action: step.action,
        source: "routine",
        lifespan: "response",
        description: `routine step ${step.id}`,
      }]
    : [];

/**
 * Walks a registered Routine graph one step per turn: it asks the injected
 * next-step selector which step the turn lands on, captures slot variables,
 * projects the landed step into steering, and renders the reply through the host's
 * step renderer. The pure engine owns the graph mechanics; generation/presentation
 * stays in the host renderer. It implements the slice-1 `ConversationRoutineRunner`
 * seam, so the engine resumes through it unchanged.
 */
export class DefaultRoutineRunner implements ConversationRoutineRunner {
  constructor(
    private readonly routines: readonly Routine[],
    private readonly selector: ConversationRoutineNextStepSelector,
    private readonly renderer: ConversationRoutineStepRenderer,
  ) {}

  async resume(input: { turn: TurnContext; state: RoutineState }): Promise<ConversationRoutineResumeResult> {
    const { turn, state } = input;
    const routine = this.routines.find((candidate) => candidate.id === state.routineId);
    if (!routine) {
      throw new Error(`routine_not_found:${state.routineId}`);
    }
    const currentStepId = state.path.at(-1) ?? routine.rootStepId;
    const currentStep = routine.steps.find((step) => step.id === currentStepId);
    if (!currentStep) {
      throw new Error(`routine_step_not_found:${routine.id}:${currentStepId}`);
    }

    const transitions = routine.transitions.filter((transition) => transition.from === currentStepId);
    const decision = await this.selector.select({ routine, state, currentStep, transitions, turn });
    const nextStep = routine.steps.find((step) => step.id === decision.nextStepId) ?? currentStep;
    const variables = { ...state.variables, ...(decision.variables ?? {}) };

    // Append to the path only when the turn actually advanced; staying on a step
    // (a re-ask) keeps the path stable rather than growing it on every repeat.
    const advanced = nextStep.id !== currentStepId;
    const nextState: RoutineState = {
      ...state,
      path: advanced ? [...state.path, nextStep.id] : state.path,
      variables,
      status: "active",
    };

    const response = await this.renderer.render({
      routine,
      step: nextStep,
      state: nextState,
      steering: projectStep(nextStep),
      turn,
    });

    return {
      response,
      // A terminal step ends the routine — clear its state.
      nextState: nextStep.kind === "terminal" ? null : nextState,
    };
  }
}
