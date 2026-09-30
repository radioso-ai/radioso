import type { Routine, RoutineState, RoutineStep } from "@radioso/conversation-contract";
import { collectedSlotsForStep, isSlotCollectionStepSatisfied } from "@radioso/conversation-engine";

import { compiledRoutineToolName, type DirectInvocationOutcome } from "./exposure/directInvocationActivator.js";
import type {
  RoutineInvocationReport,
  RoutinePendingInput,
  RoutineTurnReporter,
  RoutineTurnState,
  RoutineTurnStatus,
} from "./turnReport.js";

/**
 * The tool call a turn carries, read lazily: the activator decides during the
 * engine run, and a turn another routine keeps never runs it at all — which is
 * exactly the `not_started` outcome a caller needs to hear about.
 */
interface RoutineTurnInvocationSource {
  toolName: string;
  outcome: () => DirectInvocationOutcome | null;
}

const hasVariable = (variables: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(variables, key);

const routineDisplayName = (routine: Routine): string =>
  typeof routine.metadata?.name === "string" && routine.metadata.name.length > 0
    ? routine.metadata.name
    : routine.id;

// A chat step still lacking what it asks for, by the rule the runner uses to skip it: an
// unfilled optional slot alone never reports `waiting_for_input`.
const isWaitingForInput = (
  routine: Routine,
  currentStep: RoutineStep | undefined,
  variables: Record<string, unknown>,
): boolean =>
  currentStep?.kind === "chat" &&
  collectedSlotsForStep(currentStep).length > 0 &&
  !isSlotCollectionStepSatisfied(routine, currentStep, variables);

const statusFor = (
  routine: Routine,
  state: RoutineState,
  currentStep: RoutineStep | undefined,
  awaitingDecision: boolean,
): RoutineTurnStatus => {
  if (state.status === "expired") {
    return "abandoned";
  }
  if (state.status === "completed") {
    return "completed";
  }
  if (awaitingDecision || state.status === "suspended") {
    return "waiting_for_approval";
  }
  return isWaitingForInput(routine, currentStep, state.variables) ? "waiting_for_input" : "active";
};

/**
 * Every declared required slot not yet filled, plus the current step's unfilled
 * optional slots, in declaration order — so a calling agent can supply everything
 * it needs to in one re-call.
 */
const pendingInputFor = (
  routine: Routine,
  state: RoutineState,
  currentStep: RoutineStep | undefined,
): RoutinePendingInput[] => {
  const currentStepSlots = new Set(currentStep ? collectedSlotsForStep(currentStep) : []);
  return (routine.slots ?? [])
    .filter((slot) => !hasVariable(state.variables, slot.key))
    .filter((slot) => slot.required || currentStepSlots.has(slot.key))
    .map((slot) => ({
      key: slot.key,
      type: slot.type,
      required: slot.required,
      ...(slot.description ? { description: slot.description } : {}),
    }));
};

const isOpen = (status: RoutineTurnStatus): boolean =>
  status !== "completed" && status !== "abandoned";

const identityOf = (routine: Routine): Pick<RoutineTurnState, "toolName" | "name"> => {
  const toolName = compiledRoutineToolName(routine);
  return {
    ...(toolName ? { toolName } : {}),
    name: routineDisplayName(routine),
  };
};

/**
 * Reports a routine state in envelope terms over the routines this turn could
 * see. Exposure only adds the tool name: any admitted routine is described the
 * same way, and an unknown routine id (a state from a routine no longer
 * registered) reports nothing rather than guessing. `invocation` is the tool
 * call this turn carried, when it carried one: its outcome is what the reply
 * reports, and a declined outcome names the completed routine the call asked
 * for so the reply can still describe it (Decision 9).
 */
export const createRoutineTurnReporter = (
  routines: readonly Routine[],
  options: { invocation?: RoutineTurnInvocationSource } = {},
): RoutineTurnReporter => {
  const routinesById = new Map(routines.map((routine) => [routine.id, routine]));
  return {
    describe: ({ state, awaitingDecision = false }): RoutineTurnState | null => {
      const routine = routinesById.get(state.routineId);
      if (!routine) {
        return null;
      }
      // The path records real advances only: a routine re-asking its root step on
      // the activation turn still has an empty path, and its current step is the root.
      const currentStepId = state.path.at(-1) ?? routine.rootStepId;
      const currentStep = routine.steps.find((step) => step.id === currentStepId);
      const status = statusFor(routine, state, currentStep, awaitingDecision);
      return {
        ...identityOf(routine),
        status,
        pendingInput: isOpen(status) ? pendingInputFor(routine, state, currentStep) : [],
      };
    },
    describeDeclined: (): RoutineTurnState | null => {
      const outcome = options.invocation?.outcome() ?? null;
      const routine = outcome?.kind === "declined" ? routinesById.get(outcome.routineId) : undefined;
      return routine ? { ...identityOf(routine), status: "completed", pendingInput: [] } : null;
    },
    describeInvocation: (): RoutineInvocationReport | null => {
      if (!options.invocation) {
        return null;
      }
      const outcome = options.invocation.outcome();
      return { toolName: options.invocation.toolName, outcome: outcome?.kind ?? "not_started" };
    },
    describeRoutineName: (routineId: string): string | null => {
      const routine = routinesById.get(routineId);
      return routine ? routineDisplayName(routine) : null;
    },
  };
};
