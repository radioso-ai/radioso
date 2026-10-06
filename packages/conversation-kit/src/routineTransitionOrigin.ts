import type { RoutineTransition } from "@radioso/conversation-contract";

type RoutineTransitionOrigin = NonNullable<RoutineTransition["origin"]>;

export const isRoutineTransitionOrigin = (value: unknown): value is RoutineTransitionOrigin =>
  value === "compiler_slot_gate";
