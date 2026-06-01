import type {
  ConversationRoutineNextStepSelector,
  ConversationRoutineResumeResult,
  ConversationRoutineRunner,
  ConversationRoutineSkillDispatcher,
  ConversationRoutineStepRenderer,
  Routine,
  RoutineSkillResult,
  RoutineState,
  RoutineStep,
  RoutineTransition,
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
 * Walks a registered Routine graph for the current turn: it asks the injected
 * next-step selector which step the turn lands on, captures slot variables, runs
 * through any skill (tool) steps it lands on — dispatching the skill and advancing
 * (a single outgoing edge auto-advances; multiple edges defer to the selector with
 * the skill result) — then projects the landed chat/terminal step into steering and
 * renders the reply through the host step renderer. The pure engine owns the graph
 * mechanics; generation/presentation stays in the host. Implements the slice-1
 * `ConversationRoutineRunner` seam, so the engine resumes through it unchanged.
 */
export class DefaultRoutineRunner implements ConversationRoutineRunner {
  constructor(
    private readonly routines: readonly Routine[],
    private readonly selector: ConversationRoutineNextStepSelector,
    private readonly renderer: ConversationRoutineStepRenderer,
    private readonly skillDispatcher?: ConversationRoutineSkillDispatcher,
  ) {}

  async resume(input: { turn: TurnContext; state: RoutineState }): Promise<ConversationRoutineResumeResult> {
    const { turn, state } = input;
    const routine = this.routines.find((candidate) => candidate.id === state.routineId);
    if (!routine) {
      throw new Error(`routine_not_found:${state.routineId}`);
    }
    const stepById = (id: string): RoutineStep => {
      const step = routine.steps.find((candidate) => candidate.id === id);
      if (!step) {
        throw new Error(`routine_step_not_found:${routine.id}:${id}`);
      }
      return step;
    };
    const outgoing = (stepId: string): RoutineTransition[] => routine.transitions.filter((t) => t.from === stepId);

    const currentStepId = state.path.at(-1) ?? routine.rootStepId;
    const currentStep = stepById(currentStepId);

    // Select the step this turn lands on from the current step's outgoing edges.
    const decision = await this.selector.select({
      routine,
      state,
      currentStep,
      transitions: outgoing(currentStepId),
      turn,
    });
    let step = decision.nextStepId === currentStepId ? currentStep : stepById(decision.nextStepId);
    let variables = { ...state.variables, ...(decision.variables ?? {}) };
    // Append to the path only on a real advance; re-asking a step keeps it stable.
    const path = step.id === currentStepId ? [...state.path] : [...state.path, step.id];

    // Run through any skill (tool) steps: dispatch, then advance past them.
    while (step.kind === "skill") {
      if (!this.skillDispatcher) {
        throw new Error(`routine_skill_dispatcher_missing:${routine.id}:${step.id}`);
      }
      if (!step.skillName) {
        throw new Error(`routine_skill_step_missing_skill:${routine.id}:${step.id}`);
      }
      const skillStateAtStep: RoutineState = { ...state, path, variables, status: "active" };
      const skillResult: RoutineSkillResult = await this.skillDispatcher.dispatch({
        skillName: step.skillName,
        state: skillStateAtStep,
        turn,
      });
      const skillEdges = outgoing(step.id);
      let nextStep: RoutineStep;
      if (skillEdges.length === 1) {
        // Single follow-up → deterministic auto-advance, no selector call.
        nextStep = stepById(skillEdges[0]!.to);
      } else {
        const skillDecision = await this.selector.select({
          routine,
          state: skillStateAtStep,
          currentStep: step,
          transitions: skillEdges,
          turn,
          skillResult,
        });
        variables = { ...variables, ...(skillDecision.variables ?? {}) };
        nextStep = stepById(skillDecision.nextStepId);
      }
      step = nextStep;
      path.push(step.id);
    }

    const nextState: RoutineState = { ...state, path, variables, status: "active" };
    const response = await this.renderer.render({
      routine,
      step,
      state: nextState,
      steering: projectStep(step),
      turn,
    });

    return {
      response,
      // A terminal step ends the routine — clear its state.
      nextState: step.kind === "terminal" ? null : nextState,
    };
  }
}
