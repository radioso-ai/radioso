import type { Routine, RoutineRegistration } from "@radioso/conversation-contract";

/** A routine as the agent names it to a visitor who asks what it can do: its name and when it applies. */
export interface RoutineCapability {
  name: string;
  trigger: string;
}

const CAPABILITY_LABEL_KEY = "capabilityLabel";

/**
 * A compiled routine that a visitor hears named by `label`. Ranking and clarification keep reading
 * the routine's `name`, so a built-in whose name is an identifier gets a readable label here without
 * changing what routine activation sees.
 */
export const withCapabilityLabel = (routine: Routine, label: string): Routine => ({
  ...routine,
  metadata: { ...routine.metadata, [CAPABILITY_LABEL_KEY]: label },
});

const visitorName = (metadata: Routine["metadata"]): string => {
  const label = metadata?.[CAPABILITY_LABEL_KEY];
  const name = typeof label === "string" && label.trim() ? label : metadata?.name;
  return typeof name === "string" ? name.trim() : "";
};

/**
 * The routines a turn can start, as a visitor may hear them described. Only the routine's name (or
 * its capability label) and the activation trigger leave the routines module: never a step, a slot,
 * a skill, or a branch. A registration without a name is left out rather than introduced by its id.
 */
export const startableRoutineCapabilities = (registrations: readonly RoutineRegistration[]): RoutineCapability[] =>
  registrations.flatMap(({ routine, trigger }) => {
    const name = visitorName(routine.metadata);
    return name ? [{ name, trigger: trigger.description }] : [];
  });
