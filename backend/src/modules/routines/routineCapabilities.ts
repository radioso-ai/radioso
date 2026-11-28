import type { RoutineRegistration } from "@radioso/conversation-contract";

/** A routine as the agent names it to a visitor who asks what it can do: its name and when it applies. */
export interface RoutineCapability {
  name: string;
  trigger: string;
}

/**
 * The routines a turn can start, as a visitor may hear them described. Only the authored name and
 * the activation trigger leave the routines module: never a step, a slot, a skill, or a branch. A
 * registration without an authored name is left out rather than introduced by its id.
 */
export const startableRoutineCapabilities = (registrations: readonly RoutineRegistration[]): RoutineCapability[] =>
  registrations.flatMap(({ routine, trigger }) => {
    const name = typeof routine.metadata?.name === "string" ? routine.metadata.name.trim() : "";
    return name ? [{ name, trigger: trigger.description }] : [];
  });
