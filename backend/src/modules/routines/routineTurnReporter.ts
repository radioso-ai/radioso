import type { Routine, RoutineState, RoutineStep } from "@radioso/conversation-contract";

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

// Mirrors the engine's own read of a chat step's collected slots
// (`routineRunner.ts` `collectedSlotsFor`), so "waiting for input" here agrees
// with the step the runner would fast-forward once those slots are filled.
const collectedSlotsFor = (step: RoutineStep | undefined): string[] => {
  const value = step?.metadata?.collectsSlots;
  return Array.isArray(value) && value.every((candidate): candidate is string => typeof candidate === "string")
    ? value
    : [];
};

const routineDisplayName = (routine: Routine): string =>
  typeof routine.metadata?.name === "string" && routine.metadata.name.length > 0
    ? routine.metadata.name
    : routine.id;

const statusFor = (
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
  const unfilledCollectedSlots = collectedSlotsFor(currentStep).some((key) => !hasVariable(state.variables, key));
  return currentStep?.kind === "chat" && unfilledCollectedSlots ? "waiting_for_input" : "active";
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
  const currentStepSlots = new Set(collectedSlotsFor(currentStep));
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
      const status = statusFor(state, currentStep, awaitingDecision);
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
  };
};
