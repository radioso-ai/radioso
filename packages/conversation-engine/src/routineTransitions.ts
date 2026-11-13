import type { RoutineTransition } from "@radioso/conversation-contract";

/** An exit the runner takes when no other exit of its step holds. */
export const isDefaultTransition = (transition: RoutineTransition): boolean =>
  transition.guard?.kind === "default";

/** An exit the next-step selector judges; an exit with no guard is one too. */
export const isLlmTransition = (transition: RoutineTransition): boolean =>
  !transition.guard || transition.guard.kind === "llm";

/** The exit the compiler gives a plain collection step: it asks only whether the step's slots hold values. */
export const isCompilerSlotGate = (transition: RoutineTransition): boolean =>
  transition.origin === "compiler_slot_gate" && isLlmTransition(transition);

/** An AI-decides exit the author wrote. */
export const isAuthoredLlmExit = (transition: RoutineTransition): boolean =>
  isLlmTransition(transition) && !isCompilerSlotGate(transition);
