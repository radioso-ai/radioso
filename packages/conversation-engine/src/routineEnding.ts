import type {
  ConversationRoutineResumeResult,
  ProcessTurnResult,
  Routine,
  RoutineActionRequest,
  RoutineAuthoredTerminalKind,
  RoutineOperatorNoticeEffect,
  RoutineOperatorNoticeTemplate,
  RoutineState,
  RoutineStep,
} from "@radioso/conversation-contract";
import { redactSensitiveValues } from "@radioso/conversation-contract";

const hasVariable = (variables: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(variables, key);

/** The routine's slot keys its author marked sensitive, in declared order. */
export const sensitiveSlotKeys = (routine: Routine): string[] =>
  (routine.slots ?? []).filter((slot) => slot.sensitivity === "sensitive").map((slot) => slot.key);

/**
 * The variables as a copy that leaves the conversation carries them: a sensitive slot's value
 * reads as the redaction marker. The run's own state keeps the value, since the routine needs it
 * to run; every payload, ending, and trace the runner hands out goes through here.
 */
export const outboundVariables = (
  routine: Routine,
  variables: Record<string, unknown>,
): Record<string, unknown> => redactSensitiveValues(variables, sensitiveSlotKeys(routine));

/** The declared slots' values as they leave the conversation, sensitive ones masked. */
export const declaredSlotVariables = (
  routine: Routine,
  variables: Record<string, unknown>,
): Record<string, unknown> =>
  outboundVariables(
    routine,
    Object.fromEntries(
      (routine.slots ?? [])
        .map((slot) => slot.key)
        .filter((key) => hasVariable(variables, key))
        .map((key) => [key, variables[key]]),
    ),
  );

/** The keys of an ending's collected values that were masked as sensitive, reported beside them. */
export const maskedSlotKeys = (
  routine: Routine,
  collected: Record<string, unknown>,
): Pick<NonNullable<ConversationRoutineResumeResult["terminal"]>, "sensitiveSlotKeys"> => {
  const keys = sensitiveSlotKeys(routine).filter((key) => hasVariable(collected, key));
  return keys.length > 0 ? { sensitiveSlotKeys: keys } : {};
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

export const terminalResult = (
  routine: Routine,
  kind: RoutineAuthoredTerminalKind,
  step: RoutineStep,
  collected: Record<string, unknown>,
): NonNullable<ConversationRoutineResumeResult["terminal"]> => {
  const operatorNotice = operatorNoticeTemplateFor(step);
  return { kind, stepId: step.id, collected, ...maskedSlotKeys(routine, collected), ...(operatorNotice ? { operatorNotice } : {}) };
};

export const completionExportActionFor = (
  routine: Routine,
  step: RoutineStep,
  terminalKind: RoutineAuthoredTerminalKind | null,
  variables: Record<string, unknown>,
): RoutineActionRequest | null => {
  const completionExport = routine.completionExport;
  if (
    !completionExport?.enabled ||
    !completionExport.destinationRef ||
    (terminalKind !== "complete" && terminalKind !== "handoff") ||
    !completionExport.triggerKinds.includes(terminalKind)
  ) {
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
