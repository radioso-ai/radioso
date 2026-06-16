import type {
  ConversationRoutineNextStepSelector,
  ConversationRoutineResumeResult,
  ConversationRoutineRunner,
  ConversationRoutineSkillDispatcher,
  ConversationRoutineSteeringResolver,
  ConversationRoutineStepRenderer,
  Routine,
  RoutineActionRequest,
  RoutineGuard,
  RoutineNextStepDecision,
  RoutineRunTrace,
  RoutineSkillResult,
  RoutineState,
  RoutineStep,
  RoutineTraceStepEntry,
  RoutineTransition,
  SteeringRule,
  TurnContext,
} from "@radioso/conversation-contract";

type RoutineFieldGuard = Extract<RoutineGuard, { kind: "field" }>;

/**
 * Resolve a field guard's `ref` to a concrete value: the last skill result's typed
 * `outputs` take precedence (the tool computed it), then captured slot variables.
 * Returns `undefined` when nothing provides the reference.
 */
const resolveFieldValue = (
  ref: string,
  variables: Record<string, unknown>,
  skillResult?: RoutineSkillResult,
): unknown => {
  const outputs = skillResult?.outputs;
  if (outputs && Object.prototype.hasOwnProperty.call(outputs, ref)) {
    return outputs[ref];
  }
  return Object.prototype.hasOwnProperty.call(variables, ref) ? variables[ref] : undefined;
};

const toNumber = (value: unknown): number | null => {
  if (typeof value === "number") return Number.isNaN(value) ? null : value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
};

const toDate = (value: unknown): Date | null => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
};

// `now` minus (amount × unit), using calendar arithmetic so "6 months" respects month
// boundaries (the date math the model gets wrong — done once, in code).
const subtractDuration = (now: Date, amount: number, unit: NonNullable<RoutineFieldGuard["unit"]>): Date => {
  const result = new Date(now.getTime());
  switch (unit) {
    case "days":
      result.setDate(result.getDate() - amount);
      break;
    case "weeks":
      result.setDate(result.getDate() - amount * 7);
      break;
    case "months":
      result.setMonth(result.getMonth() - amount);
      break;
    case "years":
      result.setFullYear(result.getFullYear() - amount);
      break;
  }
  return result;
};

/**
 * Evaluate a deterministic field guard in code — no model call. This is the branch
 * that lets a routine decide on tool-computed facts (e.g. `is_final_sale === true`,
 * `status in {…}`, `order_date older_than 6 months`) with the same certainty every time.
 */
const evaluateFieldGuard = (
  guard: RoutineFieldGuard,
  variables: Record<string, unknown>,
  skillResult: RoutineSkillResult | undefined,
  now: Date,
): boolean => {
  const actual = resolveFieldValue(guard.ref, variables, skillResult);
  switch (guard.op) {
    case "is_true":
      return actual === true;
    case "is_false":
      return actual === false;
    case "is_present":
      return actual !== undefined && actual !== null;
    case "is_absent":
      return actual === undefined || actual === null;
    case "equals":
      return actual === guard.value;
    case "not_equals":
      return actual !== guard.value;
    case "in":
      return Array.isArray(guard.values) && guard.values.some((candidate) => candidate === actual);
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const left = toNumber(actual);
      const right = toNumber(guard.value);
      if (left === null || right === null) return false;
      if (guard.op === "gt") return left > right;
      if (guard.op === "gte") return left >= right;
      if (guard.op === "lt") return left < right;
      return left <= right;
    }
    case "older_than":
    case "within": {
      const date = toDate(actual);
      const amount = toNumber(guard.value);
      if (date === null || amount === null || !guard.unit) return false;
      const threshold = subtractDuration(now, amount, guard.unit);
      return guard.op === "older_than" ? date.getTime() < threshold.getTime() : date.getTime() >= threshold.getTime();
    }
    default:
      return false;
  }
};

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

const SLOT_REFERENCE = /\{\{\s*slot\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/gu;

/**
 * Substitute `{{slot.<key>}}` references in a step's instruction with the values the
 * routine has captured so far, so a confirmation like "call you at {{slot.phone}}"
 * renders the real value rather than leaking the raw token to the user. A reference to
 * a slot not captured yet resolves to an empty string, not the literal token.
 */
const interpolateSlots = (text: string, variables: Record<string, unknown>): string =>
  text.replace(SLOT_REFERENCE, (_match, key: string) =>
    Object.prototype.hasOwnProperty.call(variables, key) ? String(variables[key] ?? "") : "");

const assignOutputs = (
  outputAssignments: Record<string, string> | undefined,
  outputs: Record<string, unknown> | undefined,
): Record<string, unknown> => {
  if (!outputAssignments || !outputs) {
    return {};
  }
  const assigned: Record<string, unknown> = {};
  for (const [outputField, variableName] of Object.entries(outputAssignments)) {
    if (Object.prototype.hasOwnProperty.call(outputs, outputField)) {
      assigned[variableName] = outputs[outputField];
    }
  }
  return assigned;
};

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

const declaredSlotVariables = (
  routine: Routine,
  variables: Record<string, unknown>,
): Record<string, unknown> =>
  Object.fromEntries(
    (routine.slots ?? [])
      .map((slot) => slot.key)
      .filter((key) => hasVariable(variables, key))
      .map((key) => [key, variables[key]]),
  );

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

const isDefaultTransition = (transition: RoutineTransition): boolean =>
  transition.guard?.kind === "default";

const isLlmTransition = (transition: RoutineTransition): boolean =>
  !transition.guard || transition.guard.kind === "llm";

const terminalKindFor = (step: RoutineStep): "complete" | "handoff" | "action" | null => {
  if (step.kind !== "terminal") {
    return null;
  }
  const kind = step.metadata?.terminalKind;
  return kind === "handoff" || kind === "action" || kind === "complete" ? kind : "complete";
};

const completionExportActionFor = (
  routine: Routine,
  step: RoutineStep,
  terminalKind: "complete" | "handoff" | "action" | null,
  variables: Record<string, unknown>,
): RoutineActionRequest | null => {
  const completionExport = routine.completionExport;
  if (
    !completionExport?.enabled ||
    !completionExport.destinationRef ||
    (terminalKind !== "complete" && terminalKind !== "handoff") ||
    !completionExport.triggerKinds.includes(terminalKind)
  ) {
    return null;
  }

  return {
    type: "webhook.send",
    payload: {
      destinationRef: completionExport.destinationRef,
      source: {
        routineId: routine.id,
        stepId: step.id,
        terminalKind,
        status: "completed",
      },
      data: declaredSlotVariables(routine, variables),
    },
  };
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
    // Injectable so relative-date guards ("older_than 6 months") are deterministic in tests.
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async resume(input: {
    turn: TurnContext;
    state: RoutineState;
    steeringResolver?: ConversationRoutineSteeringResolver;
  }): Promise<ConversationRoutineResumeResult> {
    const { turn, state } = input;
    const now = this.clock();
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

    // Debug trace: a step-by-step log of this turn's traversal, surfaced to the panel.
    // Slot KEYS only — never the captured values (which may be PII).
    const declaredSlotKeys = new Set((routine.slots ?? []).map((slot) => slot.key));
    const traceSteps: RoutineTraceStepEntry[] = [];
    const capturedKeysFrom = (
      before: Record<string, unknown>,
      decision?: { variables?: Record<string, unknown> },
    ): string[] => {
      if (!decision?.variables) {
        return [];
      }
      return Object.keys(decision.variables).filter(
        (key) => !hasVariable(before, key) && (declaredSlotKeys.size === 0 || declaredSlotKeys.has(key)),
      );
    };
    // Set by `selectNext` each call: whether it consulted the LLM selector (vs taking a
    // default/structured-guard edge). Read immediately after each awaited call.
    let lastSelectorRan = false;

    const attempts: Record<string, number> = { ...(state.attempts ?? {}) };
    if (state.path.length === 0) {
      attempts[currentStepId] = (attempts[currentStepId] ?? 0) + 1;
    }
    const enterStep = (nextStep: RoutineStep, path: string[]): void => {
      path.push(nextStep.id);
      attempts[nextStep.id] = (attempts[nextStep.id] ?? 0) + 1;
    };
    const guardMatches = (
      transition: RoutineTransition,
      fromStepId: string,
      variables: Record<string, unknown>,
      skillResult?: RoutineSkillResult,
    ): boolean => {
      switch (transition.guard?.kind) {
        case "slot_filled":
          return transition.guard.slots.length > 0 && transition.guard.slots.every((slot) => hasVariable(variables, slot));
        case "outcome":
          return skillResult?.status === transition.guard.status;
        case "counter":
          return (attempts[fromStepId] ?? 0) < transition.guard.limit;
        case "field":
          return evaluateFieldGuard(transition.guard, variables, skillResult, now);
        default:
          return false;
      }
    };
    const selectNext = async (input: {
      step: RoutineStep;
      transitions: RoutineTransition[];
      variables: Record<string, unknown>;
      state: RoutineState;
      skillResult?: RoutineSkillResult;
      defaultOnDecline?: boolean;
    }): Promise<RoutineNextStepDecision> => {
      lastSelectorRan = false;
      const defaultTransition = input.transitions.find(isDefaultTransition);
      const conditionedTransitions = input.transitions.filter((transition) => !isDefaultTransition(transition));

      // A slot-collection step must capture the user's answer even when all of its
      // branches are deterministic (a field/counter guard, or a bare default) — the
      // selector is the only place variables are extracted, yet it normally runs only
      // for an `llm` edge. A step that asks for {{slot.x}} and then branches on x in
      // code therefore never captured x (so the branch could never see it). When no
      // `llm` edge will trigger the selector, run an extraction-only pass first and let
      // the deterministic guards below decide the branch from the merged values.
      //
      // Only when at least one collected slot is still missing. A *satisfied* step
      // (every slot already filled) is reached on the fast-forward walk — running the
      // selector there would add a model round-trip to a deterministic path, let an
      // unrelated message overwrite an already-filled slot, and could spuriously yield
      // the turn. "Already collected" means nothing to extract, so skip it.
      const collected = collectedSlotsFor(input.step);
      let extracted: Record<string, unknown> = {};
      if (
        collected.length > 0 &&
        collected.some((key) => !hasVariable(input.variables, key)) &&
        input.transitions.length > 0 &&
        !conditionedTransitions.some(isLlmTransition)
      ) {
        lastSelectorRan = true;
        const extraction = await this.selector.select({
          routine,
          state: input.state,
          currentStep: input.step,
          transitions: input.transitions,
          turn,
          ...(input.skillResult ? { skillResult: input.skillResult } : {}),
        });
        // Off-topic on a slot step still yields the turn, same as the llm path.
        if (extraction.yieldTurn) {
          return extraction;
        }
        extracted = extraction.variables ?? {};
      }
      const variables = { ...input.variables, ...extracted };
      // Thread the extraction-only capture onto whatever branch the guards pick, so the
      // caller merges (and the trace records) the slot even though the LLM didn't choose
      // the edge.
      const withExtracted = (decision: RoutineNextStepDecision): RoutineNextStepDecision =>
        Object.keys(extracted).length > 0
          ? { ...decision, variables: { ...extracted, ...(decision.variables ?? {}) } }
          : decision;

      if (defaultTransition && conditionedTransitions.length === 0) {
        return withExtracted({ nextStepId: defaultTransition.to });
      }

      for (const transition of conditionedTransitions) {
        if (guardMatches(transition, input.step.id, variables, input.skillResult)) {
          return withExtracted({ nextStepId: transition.to });
        }
      }

      const llmTransitions = conditionedTransitions.filter(isLlmTransition);
      if (llmTransitions.length === 0) {
        return withExtracted({ nextStepId: defaultTransition?.to ?? input.step.id });
      }

      lastSelectorRan = true;
      const decision = await this.selector.select({
        routine,
        state: input.state,
        currentStep: input.step,
        transitions: llmTransitions,
        turn,
        ...(input.skillResult ? { skillResult: input.skillResult } : {}),
      });
      if (decision.yieldTurn) {
        return decision;
      }
      const allowed = new Set([input.step.id, ...llmTransitions.map((transition) => transition.to)]);
      const chosen = allowed.has(decision.nextStepId) ? decision.nextStepId : input.step.id;
      if (input.defaultOnDecline && chosen === input.step.id && defaultTransition) {
        return { ...decision, nextStepId: defaultTransition.to };
      }
      return { ...decision, nextStepId: chosen };
    };

    // Select the step this turn lands on from the current step's outgoing edges.
    const decision = await selectNext({
      step: currentStep,
      transitions: outgoing(currentStepId),
      variables: state.variables,
      state: { ...state, attempts },
    });
    // The user's message is off-topic for the routine → decline this turn and let
    // normal answering handle it; the routine stays at its current step to resume.
    // response/nextState are inert placeholders the engine ignores on a yield.
    if (decision.yieldTurn) {
      return { yielded: true, response: { answer: "" }, nextState: null };
    }
    const mainSelectorRan = lastSelectorRan;
    const landedId = landingStepId(currentStepId, decision);
    let step = landedId === currentStepId ? currentStep : stepById(landedId);
    let variables = { ...state.variables, ...(decision.variables ?? {}) };
    // Trace the resume step's outcome: it either advanced off (the user satisfied it) or
    // was re-asked. Captured keys, if any, belong to this step's edge evaluation.
    {
      const captured = capturedKeysFrom(state.variables, decision);
      traceSteps.push({
        stepId: currentStep.id,
        kind: currentStep.kind,
        event: step.id === currentStepId ? "reasked" : "advanced",
        ...(captured.length > 0 ? { capturedSlotKeys: captured } : {}),
        viaSelector: mainSelectorRan,
      });
    }
    // Append to the path only on a real advance; re-asking a step keeps it stable.
    const path = step.id === currentStepId ? [...state.path] : [...state.path, step.id];
    if (step.id !== currentStepId) {
      attempts[step.id] = (attempts[step.id] ?? 0) + 1;
    }

    // Skip slot-collection steps whose slots are already filled, so an intake never
    // re-asks for a value the routine already holds. A bounded loop (a `counter`
    // back-edge into a satisfied step) would otherwise fast-forward forever — track the
    // steps visited this traversal and, on a revisit, stop and render the current step
    // instead of throwing. This keeps the runner on the degrade-don't-throw path: a
    // loop that can't fast-forward to progress settles on a chat step the user can act on.
    const fastForwarded = new Set<string>([step.id]);
    while (isSatisfiedSlotCollectionStep(routine, step, variables)) {
      const stepEdges = outgoing(step.id);
      if (stepEdges.length === 0) {
        break;
      }

      const fastForwardEntry: RoutineTraceStepEntry = {
        stepId: step.id,
        kind: step.kind,
        event: "fast_forwarded",
      };
      let nextStepId: string;
      if (stepEdges.length === 1) {
        nextStepId = stepEdges[0]!.to;
      } else {
        const fastForwardState: RoutineState = { ...state, path, variables, attempts, status: "active" };
        const beforeFastForward = variables;
        const fastForwardDecision = await selectNext({
          step,
          transitions: stepEdges,
          variables,
          state: fastForwardState,
        });
        if (fastForwardDecision.yieldTurn) {
          return { yielded: true, response: { answer: "" }, nextState: null };
        }
        if (lastSelectorRan) {
          fastForwardEntry.viaSelector = true;
        }
        const captured = capturedKeysFrom(beforeFastForward, fastForwardDecision);
        if (captured.length > 0) {
          fastForwardEntry.capturedSlotKeys = captured;
        }
        variables = { ...variables, ...(fastForwardDecision.variables ?? {}) };
        nextStepId = landingStepId(step.id, fastForwardDecision);
        if (nextStepId === step.id) {
          break;
        }
      }

      // Would re-enter a step already visited this traversal (a loop). Render the step
      // we're on rather than chasing the cycle. Break BEFORE recording the skip: this
      // step is about to be rendered, not skipped, so labelling it `fast_forwarded`
      // would make the debug panel show the step the user replied from as "Skipped".
      if (fastForwarded.has(nextStepId)) {
        break;
      }
      traceSteps.push(fastForwardEntry);
      step = stepById(nextStepId);
      fastForwarded.add(step.id);
      enterStep(step, path);
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
        traceSteps.push({ stepId: step.id, kind: step.kind, event: "action_emitted" });
        step = stepById(actionEdges[0]!.to);
        enterStep(step, path);
        continue;
      }

      // skill step: dispatch, then advance off it.
      if (!this.skillDispatcher) {
        throw new Error(`routine_skill_dispatcher_missing:${routine.id}:${step.id}`);
      }
      if (!step.skillName) {
        throw new Error(`routine_skill_step_missing_skill:${routine.id}:${step.id}`);
      }
      const skillStateAtStep: RoutineState = { ...state, path, variables, attempts, status: "active" };
      const skillResult: RoutineSkillResult = await this.skillDispatcher.dispatch({
        skillName: step.skillName,
        state: skillStateAtStep,
        turn,
        ...(step.inputBindings ? { inputBindings: step.inputBindings } : {}),
        ...(step.outputAssignments ? { outputAssignments: step.outputAssignments } : {}),
      });
      variables = { ...variables, ...assignOutputs(step.outputAssignments, skillResult.outputs) };
      const skillEntry: RoutineTraceStepEntry = {
        stepId: step.id,
        kind: step.kind,
        event: "skill_dispatched",
        ...(step.skillName ? { skillName: step.skillName } : {}),
        skillStatus: skillResult.status,
      };
      traceSteps.push(skillEntry);
      const skillEdges = outgoing(step.id);
      if (skillEdges.length === 0) {
        throw new Error(`routine_skill_step_no_follow_up:${routine.id}:${step.id}`);
      }
      let nextStepId: string;
      if (skillEdges.length === 1 && isLlmTransition(skillEdges[0]!)) {
        // Legacy single follow-up → deterministic auto-advance, no selector call.
        nextStepId = skillEdges[0]!.to;
      } else {
        const beforeSkill = variables;
        const skillDecision = await selectNext({
          step,
          transitions: skillEdges,
          variables,
          state: { ...skillStateAtStep, variables },
          skillResult,
          defaultOnDecline: true,
        });
        if (lastSelectorRan) {
          skillEntry.viaSelector = true;
        }
        const capturedAtSkill = capturedKeysFrom(beforeSkill, skillDecision);
        if (capturedAtSkill.length > 0) {
          skillEntry.capturedSlotKeys = capturedAtSkill;
        }
        variables = { ...variables, ...(skillDecision.variables ?? {}) };
        const chosen = landingStepId(step.id, skillDecision);
        // If the selector declined to pick an edge, advance along the first declared
        // one rather than parking on (and re-dispatching) the skill step.
        if (chosen === step.id) {
          if (skillEdges.some(isLlmTransition)) {
            nextStepId = skillEdges[0]!.to;
          } else {
            throw new Error(`routine_skill_step_no_matching_follow_up:${routine.id}:${step.id}:${skillResult.status}`);
          }
        } else {
          nextStepId = chosen;
        }
      }
      step = stepById(nextStepId);
      enterStep(step, path);
    }

    const nextState: RoutineState = { ...state, path, variables, attempts, status: "active" };
    // Fill the captured slot values into the step's instruction before it reaches the
    // renderer, so references like "{{slot.phone}}" render the real value.
    const renderedStep = step.action
      ? { ...step, action: interpolateSlots(step.action, variables) }
      : step;
    const baseSteering = projectStep(renderedStep);
    const steering = input.steeringResolver
      ? await input.steeringResolver.resolve({ step, baseSteering, turn })
      : baseSteering;

    const response = await this.renderer.render({
      step: renderedStep,
      steering,
      turn,
    });

    const terminalKind = terminalKindFor(step);
    const completionExportAction = completionExportActionFor(routine, step, terminalKind, variables);
    if (completionExportAction) {
      actions.push(completionExportAction);
    }

    // Mark the step the turn replied from — unless it already has the last entry this
    // turn (a re-ask renders the very step it stayed on), which would list it twice.
    const lastTraceEntry = traceSteps[traceSteps.length - 1];
    if (!lastTraceEntry || lastTraceEntry.stepId !== step.id) {
      traceSteps.push({ stepId: step.id, kind: step.kind, event: "rendered" });
    }
    const trace: RoutineRunTrace = {
      routineId: routine.id,
      startStepId: currentStepId,
      landedStepId: step.id,
      ...(terminalKind ? { terminalKind } : {}),
      capturedSlotKeys: [...new Set(traceSteps.flatMap((entry) => entry.capturedSlotKeys ?? []))],
      filledSlotKeys: [...declaredSlotKeys].filter((key) => hasVariable(variables, key)),
      steps: traceSteps,
    };

    return {
      response,
      // A terminal step ends the routine — clear its state.
      nextState: step.kind === "terminal" ? null : nextState,
      ...(terminalKind ? { terminal: { kind: terminalKind, stepId: step.id } } : {}),
      ...(actions.length > 0 ? { actions } : {}),
      trace,
    };
  }
}
