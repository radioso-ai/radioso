import type {
  ConversationRoutineActivator,
  ConversationRoutineReentryGate,
  ConversationRoutineSlotCorrection,
  Routine,
  RoutineRegistration,
} from "@radioso/conversation-contract";

import { createRoutineTurnReporter } from "../routineTurnReporter.js";
import type { RoutineTurnReporter } from "../turnReport.js";
import { createDirectInvocationActivator, type DirectInvocationOutcome } from "./directInvocationActivator.js";
import type { RoutineInvocation } from "./routineInvocationValidator.js";

// Both gates are silenced on an invocation turn: the engine consults them against
// the completed routine before the activator, and an unrelated completed routine
// could otherwise read the synthetic `toolName {json}` text through a model prompt
// and capture the turn. The direct-invocation activator alone decides.
const inertReentryGate: ConversationRoutineReentryGate = {
  decide: () => Promise.resolve({ kind: "suppress" }),
};
const inertSlotCorrection: ConversationRoutineSlotCorrection = {
  detect: () => Promise.resolve(null),
  confirm: () => Promise.reject(new Error("routine_slot_correction_inert_on_invocation")),
  rejectInvalid: () => Promise.reject(new Error("routine_slot_correction_inert_on_invocation")),
};

interface DirectInvocationTurnPorts {
  /** The routine the tool name resolved to among this turn's registrations; null when absent. */
  routine: Routine | null;
  activator: ConversationRoutineActivator;
  reentryGate: ConversationRoutineReentryGate;
  slotCorrection: ConversationRoutineSlotCorrection;
  /** Reports the admitted state as usual and, when the activator declined, the completed routine it named. */
  reporter: RoutineTurnReporter;
}

/**
 * The routine ports a turn provider hands the engine when a tool call names the
 * routine to run. One producer for the pairing — activator, silenced gates, and
 * a reporter that can still describe a declined completed routine — so every
 * provider (production, test app) admits an invocation the same way.
 * `onOutcome` fires once, after the activator decided, for observability.
 */
export const createDirectInvocationTurnPorts = (input: {
  registrations: readonly RoutineRegistration[];
  routines: readonly Routine[];
  invocation: RoutineInvocation;
  onOutcome?: (outcome: DirectInvocationOutcome) => void;
}): DirectInvocationTurnPorts => {
  const directActivator = createDirectInvocationActivator(input.registrations, input.invocation);
  return {
    routine: directActivator.routine,
    activator: {
      activate: async (activationInput) => {
        const activation = await directActivator.activate(activationInput);
        const outcome = directActivator.outcome();
        if (outcome) {
          input.onOutcome?.(outcome);
        }
        return activation;
      },
    },
    reentryGate: inertReentryGate,
    slotCorrection: inertSlotCorrection,
    reporter: createRoutineTurnReporter(input.routines, {
      invocation: { toolName: input.invocation.toolName, outcome: () => directActivator.outcome() },
    }),
  };
};
