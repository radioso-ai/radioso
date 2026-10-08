import type {
  ConversationRoutineResumeResult,
  ProcessTurnResult,
  RoutineOperatorNoticeEffect,
  RoutineState,
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
  // it — so appending it again would duplicate that entry.
  const landedStepId = result.trace?.landedStepId;
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
      ...terminal.operatorNotice,
    },
  };
};
