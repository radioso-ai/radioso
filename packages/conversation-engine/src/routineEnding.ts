import type {
  ConversationRoutineResumeResult,
  ProcessTurnResult,
  Routine,
  RoutineActionRequest,
  RoutineAuthoredTerminalKind,
  RoutineCompletionExport,
  RoutineOperatorNoticeEffect,
  RoutineOperatorNoticeTemplate,
  RoutineState,
  RoutineStep,
} from "@radioso/conversation-contract";

import { declaredSlotVariables, hasVariable, sensitiveSlotKeys } from "./routineSlotValues.js";

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

/** The kind of ending a `terminal` step is; a terminal that declares none, or an unknown one, completes. */
export const terminalKindFor = (step: RoutineStep): RoutineAuthoredTerminalKind | null => {
  if (step.kind !== "terminal") {
    return null;
  }
  const kind = step.metadata?.terminalKind;
  return kind === "handoff" || kind === "action" || kind === "complete" ? kind : "complete";
};

/**
 * The routine's completion export when it fires on an ending of `kind`, else null. The one
 * statement of when an ending exports: the runner emits the export from it, and
 * {@link completedRunSentValues} reads it back.
 */
export const firingCompletionExport = (
  routine: Routine,
  kind: RoutineAuthoredTerminalKind | null,
): RoutineCompletionExport | null => {
  const completionExport = routine.completionExport;
  if (
    !completionExport?.enabled ||
    !completionExport.destinationRef ||
    (kind !== "complete" && kind !== "handoff") ||
    !completionExport.triggerKinds.includes(kind)
  ) {
    return null;
  }
  return completionExport;
};

/** Steps that hand the run's values to someone outside the conversation the moment they run. */
const STEPS_THAT_SEND: ReadonlySet<RoutineStep["kind"]> = new Set(["skill", "action", "await"]);

/** Whether the terminal a run ended on told someone outside the conversation what it held. */
const endingSends = (routine: Routine, terminal: RoutineStep): boolean => {
  const kind = terminalKindFor(terminal);
  if (kind === "handoff") {
    return true;
  }
  const notice = terminal.metadata?.operatorNotice;
  if (typeof notice === "object" && notice !== null) {
    return true;
  }
  return firingCompletionExport(routine, kind) !== null;
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

/**
 * Whether the author routed some path of this routine to a hand-off end — people take its
 * conversations over, so a visitor stuck on a step can go to one (#1384). A routine no exit
 * leads to a hand-off step declares no such path.
 */
export const routesToHandoff = (routine: Routine): boolean =>
  routine.transitions.some((transition) => {
    const target = routine.steps.find((step) => step.id === transition.to);
    return target !== undefined && terminalKindFor(target) === "handoff";
  });

/** The keys of an ending's collected values that were masked as sensitive, reported beside them. */
export const maskedSlotKeys = (
  routine: Routine,
  collected: Record<string, unknown>,
): Pick<NonNullable<ConversationRoutineResumeResult["terminal"]>, "sensitiveSlotKeys"> => {
  const keys = sensitiveSlotKeys(routine).filter((key) => hasVariable(collected, key));
  return keys.length > 0 ? { sensitiveSlotKeys: keys } : {};
};

export const terminalResult = (
  routine: Routine,
  kind: RoutineAuthoredTerminalKind,
  step: RoutineStep,
  collected: Record<string, unknown>,
): NonNullable<ConversationRoutineResumeResult["terminal"]> => {
  const operatorNotice = operatorNoticeTemplateFor(step);
  return { kind, stepId: step.id, collected, ...maskedSlotKeys(routine, collected), ...(operatorNotice ? { operatorNotice } : {}) };
};

/**
 * The operator notice template a terminal step carries. The host's compiler puts it there
 * exactly when the ending notifies operators; the runner only reads it back, keeping the
 * fields that are strings so a malformed metadata value can never reach a notice.
 */
const operatorNoticeTemplateFor = (step: RoutineStep): RoutineOperatorNoticeTemplate | null => {
  const notice = step.kind === "terminal" ? step.metadata?.operatorNotice : undefined;
  if (typeof notice !== "object" || notice === null || Array.isArray(notice)) {
    return null;
  }
  const { subject, intro, skillName, replyToSlot, includeAiSummary } = notice as Record<string, unknown>;
  return {
    ...(typeof subject === "string" ? { subject } : {}),
    ...(typeof intro === "string" ? { intro } : {}),
    ...(typeof skillName === "string" ? { skillName } : {}),
    ...(typeof replyToSlot === "string" ? { replyToSlot } : {}),
    ...(includeAiSummary === true ? { includeAiSummary: true } : {}),
  };
};

export const completionExportActionFor = (
  routine: Routine,
  step: RoutineStep,
  terminalKind: RoutineAuthoredTerminalKind | null,
  variables: Record<string, unknown>,
): RoutineActionRequest | null => {
  const completionExport = firingCompletionExport(routine, terminalKind);
  if (!completionExport) {
    return null;
  }

  return {
    type: "webhook.send",
    payload: {
      destinationRef: completionExport.destinationRef,
      source: {
        routineId: routine.id,
        stepId: step.id,
        terminalKind,
        status: "completed",
      },
      data: declaredSlotVariables(routine, variables),
    },
  };
};
