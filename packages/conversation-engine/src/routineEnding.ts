import type {
  ConversationRoutineResumeResult,
  ProcessTurnResult,
  Routine,
  RoutineOperatorNoticeEffect,
  RoutineState,
  RoutineStep,
} from "@radioso/conversation-contract";

/**
 * The record a routine keeps once a turn ends it, built from the state that turn started on:
 * where it ended, the values it ended with, and how. A live turn and a resume after an approval
 * keep the same record (#1457), so a later turn finds the run completed whichever path ended it:
 * the routine is not started again where it runs once, and a slot correction or re-entry reads it.
 */
export const completedRoutineState = (
  state: RoutineState,
  result: Pick<ConversationRoutineResumeResult, "terminal" | "endedVariables" | "trace">,
): RoutineState => {
  // A normal terminal ending lands by moving onto a terminal step the path never held; a stuck
  // ending (#1384) lands on the chat step already last in `path` — the walk never advanced off
  // it — so appending it again would duplicate that entry. The trace is optional; the ending
  // names the same step.
  const landedStepId = result.trace?.landedStepId ?? result.terminal?.stepId;
  const path = landedStepId && landedStepId !== state.path.at(-1) ? [...state.path, landedStepId] : state.path;
  return {
    ...state,
    path,
    // The values the run ended with: `state` predates the ending turn, which can capture the last
    // slot or assign a tool output on its way to the ending (#1452).
    variables: result.endedVariables ?? state.variables,
    status: "completed",
    metadata: {
      ...(state.metadata ?? {}),
      ...(result.terminal ? { terminalKind: result.terminal.kind, terminalStepId: result.terminal.stepId } : {}),
    },
  };
};

/**
 * What a routine ending does beyond the reply, derived from the landed terminal. Every path
 * that runs a routine to its end (a live turn, a resume after an approval) reports these, so
 * the host applies the same effects whichever path landed there.
 */
export const routineEndingEffects = (
  routineId: string,
  terminal: ConversationRoutineResumeResult["terminal"],
): Pick<ProcessTurnResult, "handoff" | "operatorNotice"> => ({
  ...(terminal?.kind === "handoff" || terminal?.kind === "stuck"
    ? {
        handoff: {
          routineId,
          stepId: terminal.stepId,
          terminalKind: terminal.kind,
          ...(terminal.collected ? { collected: terminal.collected } : {}),
          ...(terminal.sensitiveSlotKeys?.length ? { sensitiveSlotKeys: terminal.sensitiveSlotKeys } : {}),
        },
      }
    : {}),
  ...(operatorNoticeFor(routineId, terminal) ?? {}),
});

/**
 * What a routine ending tells operators, reported as-is from the landed terminal: the host's
 * compiler decided which endings notify, and the host decides how to deliver. Ownership is
 * the separate `handoff` effect.
 */
const operatorNoticeFor = (
  routineId: string,
  terminal: ConversationRoutineResumeResult["terminal"],
): { operatorNotice: RoutineOperatorNoticeEffect } | undefined => {
  if (!terminal?.operatorNotice || (terminal.kind !== "complete" && terminal.kind !== "handoff")) {
    return undefined;
  }
  return {
    operatorNotice: {
      routineId,
      stepId: terminal.stepId,
      terminalKind: terminal.kind,
      ...(terminal.collected ? { collected: terminal.collected } : {}),
      ...(terminal.sensitiveSlotKeys?.length ? { sensitiveSlotKeys: terminal.sensitiveSlotKeys } : {}),
      ...terminal.operatorNotice,
    },
  };
};

/** Steps that hand the run's values to someone outside the conversation the moment they run. */
const STEPS_THAT_SEND: ReadonlySet<RoutineStep["kind"]> = new Set(["skill", "action", "await"]);

/** Whether the terminal a run ended on told someone outside the conversation what it held. */
const endingSends = (routine: Routine, terminal: RoutineStep): boolean => {
  if (terminal.metadata?.terminalKind === "handoff") {
    return true;
  }
  const notice = terminal.metadata?.operatorNotice;
  if (typeof notice === "object" && notice !== null) {
    return true;
  }
  const completionExport = routine.completionExport;
  return completionExport?.enabled === true && completionExport.triggerKinds.includes("complete");
};

/**
 * Whether a completed run already sent the values it held outside the conversation (#1714):
 * it passed a tool, action, or approval step, or the ending it reached notified operators,
 * handed off (a run stuck on a chat step ends there, handing off), or fired the routine's
 * completion export. A record that names a step the routine lacks reads as sent, since nothing
 * shows the values stayed in. Read from the run's `path` and the routine it ran, so it holds for
 * a host that keeps no `metadata` on the record.
 */
export const completedRunSentValues = (routine: Routine, state: RoutineState): boolean => {
  const stepsById = new Map(routine.steps.map((step) => [step.id, step]));
  const visited = state.path.map((stepId) => stepsById.get(stepId));
  const landed = visited.at(-1);
  if (!landed || visited.some((step) => step === undefined || STEPS_THAT_SEND.has(step.kind))) {
    return true;
  }
  return landed.kind !== "terminal" || endingSends(routine, landed);
};
