import type {
  ClarificationCandidate,
  ConversationRoutineActivator,
  Routine,
  RoutineRegistration,
} from "@radioso/conversation-contract";

import type { RoutineInvocation } from "./routineInvocationValidator.js";

/** The tool name a compiled routine is exposed under, read off its compiler metadata. */
export const compiledRoutineToolName = (routine: Pick<Routine, "metadata">): string | null => {
  const exposure = routine.metadata?.exposure;
  if (!exposure || typeof exposure !== "object") {
    return null;
  }
  const toolName = (exposure as { toolName?: unknown }).toolName;
  return typeof toolName === "string" && toolName.length > 0 ? toolName : null;
};

export type DirectInvocationOutcome =
  /** Admitted a routine that had not completed in this conversation. */
  | { kind: "started"; routineId: string }
  /** Re-admitted a completed routine whose reentry mode allows it, with the new input. */
  | { kind: "reentered"; routineId: string }
  /** Declined: the routine completed and `once_per_conversation` keeps it closed. */
  | { kind: "declined"; routineId: string }
  /** No registration this turn carries the tool name. */
  | { kind: "unknown_tool" };

interface DirectInvocationActivator extends ConversationRoutineActivator {
  /** The routine the tool name resolved to among this turn's registrations; null when absent. */
  readonly routine: Routine | null;
  /** What `activate` decided; null until it ran. */
  outcome(): DirectInvocationOutcome | null;
}

/**
 * Admits the routine a tool call names, bypassing the activation prefilter and
 * ranked match: the caller already chose. The invocation's input becomes the
 * routine's initial variables, so the runner's fast-forward skips every
 * collection step those slots satisfy. Reentry is decided here, without a
 * model call: a completed `once_per_conversation` routine stays closed (and is
 * remembered so the reply can say so); `always` and `semantic` re-admit.
 */
export const createDirectInvocationActivator = (
  registrations: readonly RoutineRegistration[],
  invocation: RoutineInvocation,
): DirectInvocationActivator => {
  const target = registrations.find((registration) => compiledRoutineToolName(registration.routine) === invocation.toolName)
    ?.routine ?? null;
  let outcome: DirectInvocationOutcome | null = null;

  return {
    routine: target,
    outcome: () => outcome,
    async activate({ suppressedRoutineIds = [] }) {
      if (!target) {
        outcome = { kind: "unknown_tool" };
        return null;
      }
      const completed = suppressedRoutineIds.includes(target.id);
      const reentryMode = target.activation?.reentryMode ?? "once_per_conversation";
      if (completed && reentryMode === "once_per_conversation") {
        outcome = { kind: "declined", routineId: target.id };
        return null;
      }
      outcome = { kind: completed ? "reentered" : "started", routineId: target.id };
      const candidate: ClarificationCandidate = {
        id: target.id,
        label: invocation.toolName,
        confidence: 1,
        payload: { routineId: target.id },
      };
      return {
        kind: "activate",
        routineId: target.id,
        variables: { ...invocation.input },
        decisionMetadata: {
          consideredCandidates: [candidate],
          decision: { kind: "auto_pick", candidate, reason: "priority" },
          reason: "direct_invocation",
        },
      };
    },
  };
};
