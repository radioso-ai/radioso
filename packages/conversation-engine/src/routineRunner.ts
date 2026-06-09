import type {
  ConversationRoutineNextStepSelector,
  ConversationRoutineResumeResult,
  ConversationRoutineRunner,
  ConversationRoutineSkillDispatcher,
  ConversationRoutineSteeringResolver,
  ConversationRoutineStepRenderer,
  Routine,
  RoutineActionRequest,
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

const hasTypedSlotSchema = (routine: Routine): boolean =>
  Array.isArray(routine.slots) && routine.slots.length > 0;

const collectedSlotsFor = (step: RoutineStep): string[] => {
  const value = step.metadata?.collectsSlots;
  return Array.isArray(value) && value.every((candidate): candidate is string => typeof candidate === "string")
    ? value
    : [];
};

const hasVariable = (variables: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(variables, key);

const isSatisfiedSlotCollectionStep = (
  routine: Routine,
  step: RoutineStep,
  variables: Record<string, unknown>,
): boolean => {
  if (step.kind !== "chat" || !hasTypedSlotSchema(routine)) {
    return false;
  }
  const collectedSlots = collectedSlotsFor(step);
  return collectedSlots.length > 0 && collectedSlots.every((key) => hasVariable(variables, key));
};

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

  async resume(input: {
    turn: TurnContext;
    state: RoutineState;
    steeringResolver?: ConversationRoutineSteeringResolver;
  }): Promise<ConversationRoutineResumeResult> {
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
    // Constrain a selector's choice to the current step (stay / re-ask) or a declared
    // successor — a selector (LLM or buggy) MUST NOT be able to jump the turn to an
    // arbitrary step (e.g. an early terminal, dropping the routine, or into a skill
    // cycle). Anything else falls back to staying put.
    const landingStepId = (fromStepId: string, decision: { nextStepId: string }): string => {
      const allowed = new Set([fromStepId, ...outgoing(fromStepId).map((t) => t.to)]);
      return allowed.has(decision.nextStepId) ? decision.nextStepId : fromStepId;
    };

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
    // The user's message is off-topic for the routine → decline this turn and let
    // normal answering handle it; the routine stays at its current step to resume.
    // response/nextState are inert placeholders the engine ignores on a yield.
    if (decision.yieldTurn) {
      return { yielded: true, response: { answer: "" }, nextState: null };
    }
    const landedId = landingStepId(currentStepId, decision);
    let step = landedId === currentStepId ? currentStep : stepById(landedId);
    let variables = { ...state.variables, ...(decision.variables ?? {}) };
    // Append to the path only on a real advance; re-asking a step keeps it stable.
    const path = step.id === currentStepId ? [...state.path] : [...state.path, step.id];

    let fastForwardHops = 0;
    while (isSatisfiedSlotCollectionStep(routine, step, variables)) {
      if (++fastForwardHops > routine.steps.length) {
        throw new Error(`routine_fast_forward_exceeded:${routine.id}:${step.id}`);
      }
      const stepEdges = outgoing(step.id);
      if (stepEdges.length === 0) {
        break;
      }

      let nextStepId: string;
      if (stepEdges.length === 1) {
        nextStepId = stepEdges[0]!.to;
      } else {
        const fastForwardState: RoutineState = { ...state, path, variables, status: "active" };
        const fastForwardDecision = await this.selector.select({
          routine,
          state: fastForwardState,
          currentStep: step,
          transitions: stepEdges,
          turn,
        });
        if (fastForwardDecision.yieldTurn) {
          return { yielded: true, response: { answer: "" }, nextState: null };
        }
        variables = { ...variables, ...(fastForwardDecision.variables ?? {}) };
        nextStepId = landingStepId(step.id, fastForwardDecision);
        if (nextStepId === step.id) {
          break;
        }
      }

      step = stepById(nextStepId);
      path.push(step.id);
    }

    // Run through any transit steps — skill (dispatch a tool) and action (emit a
    // fire-and-forget request) — advancing off each this turn, until a chat/terminal
    // step renders. Bounded by the routine's step count so a misauthored cycle fails
    // loudly instead of looping (and re-firing a side effect) forever. Neither kind is
    // ever left as the resume position.
    const actions: RoutineActionRequest[] = [];
    let hops = 0;
    while (step.kind === "skill" || step.kind === "action") {
      if (++hops > routine.steps.length) {
        throw new Error(`routine_walk_exceeded:${routine.id}:${step.id}`);
      }

      if (step.kind === "action") {
        if (!step.actionType) {
          throw new Error(`routine_action_step_missing_type:${routine.id}:${step.id}`);
        }
        const actionEdges = outgoing(step.id);
        if (actionEdges.length === 0) {
          throw new Error(`routine_action_step_no_follow_up:${routine.id}:${step.id}`);
        }
        // Fire-and-forget: record the request (authored type + the routine's variables)
        // and auto-advance — there is no result to branch on.
        actions.push({ type: step.actionType, payload: { ...variables } });
        step = stepById(actionEdges[0]!.to);
        path.push(step.id);
        continue;
      }

      // skill step: dispatch, then advance off it.
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
      if (skillEdges.length === 0) {
        throw new Error(`routine_skill_step_no_follow_up:${routine.id}:${step.id}`);
      }
      let nextStepId: string;
      if (skillEdges.length === 1) {
        // Single follow-up → deterministic auto-advance, no selector call.
        nextStepId = skillEdges[0]!.to;
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
        const chosen = landingStepId(step.id, skillDecision);
        // If the selector declined to pick an edge, advance along the first declared
        // one rather than parking on (and re-dispatching) the skill step.
        nextStepId = chosen === step.id ? skillEdges[0]!.to : chosen;
      }
      step = stepById(nextStepId);
      path.push(step.id);
    }

    const nextState: RoutineState = { ...state, path, variables, status: "active" };
    const baseSteering = projectStep(step);
    const steering = input.steeringResolver
      ? await input.steeringResolver.resolve({ step, baseSteering, turn })
      : baseSteering;

    const response = await this.renderer.render({
      step,
      steering,
      turn,
    });

    return {
      response,
      // A terminal step ends the routine — clear its state.
      nextState: step.kind === "terminal" ? null : nextState,
      ...(actions.length > 0 ? { actions } : {}),
    };
  }
}
