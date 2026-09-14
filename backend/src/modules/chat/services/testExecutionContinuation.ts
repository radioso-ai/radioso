import type { PendingClarification, RoutineState } from "@radioso/conversation-contract";

import type { DirectiveFiringState } from "../../directives/public.js";
import type { WorkbenchReplayRoutineStartState } from "./workbenchReplayRunner.js";

export interface TestExecutionReplayContinuationV1 {
  version: 1;
  routineState: WorkbenchReplayRoutineStartState | null;
  pendingClarification: Omit<PendingClarification, "sessionId"> | null;
  directiveState: DirectiveFiringState | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const cloneRoutineState = (state: RoutineState | null): WorkbenchReplayRoutineStartState | null => {
  if (!state) return null;
  const { sessionId: _sessionId, ...continuation } = state;
  return {
    ...continuation,
    path: [...continuation.path],
    variables: { ...continuation.variables },
    ...(continuation.attempts ? { attempts: { ...continuation.attempts } } : {}),
    ...(continuation.metadata ? { metadata: { ...continuation.metadata } } : {}),
  };
};

const clonePending = (pending: PendingClarification | null): Omit<PendingClarification, "sessionId"> | null => {
  if (!pending) return null;
  const { sessionId: _sessionId, ...continuation } = pending;
  return { ...continuation, candidates: continuation.candidates.map((candidate) => ({ ...candidate })) };
};

const cloneDirectiveState = (state: DirectiveFiringState | null): DirectiveFiringState | null =>
  state ? { turnSeq: state.turnSeq, firings: Object.fromEntries(Object.entries(state.firings).map(([name, firing]) => [name, { ...firing }])) } : null;

const invalid = (): never => { throw new Error("test_execution_continuation_invalid"); };

const parseRoutineState = (value: unknown): WorkbenchReplayRoutineStartState | null => {
  if (value === null) return null;
  if (!isRecord(value) || typeof value.routineId !== "string" || !isStringArray(value.path)
    || !isRecord(value.variables) || !["active", "suspended", "completed", "expired"].includes(String(value.status))) {
    return invalid();
  }
  if (value.attempts !== undefined && (!isRecord(value.attempts) || !Object.values(value.attempts).every((count) => typeof count === "number" && Number.isFinite(count)))) return invalid();
  if (value.metadata !== undefined && !isRecord(value.metadata)) return invalid();
  return {
    routineId: value.routineId,
    path: [...value.path],
    variables: { ...value.variables },
    status: value.status as WorkbenchReplayRoutineStartState["status"],
    ...(value.attempts ? { attempts: { ...value.attempts } as Record<string, number> } : {}),
    ...(value.metadata ? { metadata: { ...value.metadata } } : {}),
  };
};

const parsePending = (value: unknown): Omit<PendingClarification, "sessionId"> | null => {
  if (value === null) return null;
  if (!isRecord(value) || typeof value.source !== "string" || !Array.isArray(value.candidates)
    || !["pending", "resolved", "declined", "expired"].includes(String(value.status))
    || (typeof value.expiresAt !== "string" && !(value.expiresAt instanceof Date))) return invalid();
  if (!value.candidates.every((candidate) => isRecord(candidate)
    && typeof candidate.id === "string" && typeof candidate.label === "string")) return invalid();
  return {
    source: value.source,
    candidates: value.candidates as PendingClarification["candidates"],
    status: value.status as PendingClarification["status"],
    expiresAt: value.expiresAt,
    ...(typeof value.originalQuery === "string" ? { originalQuery: value.originalQuery } : {}),
    ...(value.mode === "ask" || value.mode === "offer" ? { mode: value.mode } : {}),
    ...(typeof value.askedEventId === "string" ? { askedEventId: value.askedEventId } : {}),
  };
};

const parseDirectiveState = (value: unknown): DirectiveFiringState | null => {
  if (value === null) return null;
  if (!isRecord(value) || typeof value.turnSeq !== "number" || !Number.isInteger(value.turnSeq) || !isRecord(value.firings)) return invalid();
  for (const firing of Object.values(value.firings)) {
    if (!isRecord(firing) || typeof firing.lastFiredTurn !== "number" || !Number.isInteger(firing.lastFiredTurn)
      || typeof firing.count !== "number" || !Number.isInteger(firing.count)) return invalid();
  }
  return cloneDirectiveState(value as unknown as DirectiveFiringState);
};

export const exportTestExecutionReplayContinuation = (input: {
  routineState: RoutineState | null;
  pendingClarification: PendingClarification | null;
  directiveState: DirectiveFiringState | null;
}): TestExecutionReplayContinuationV1 => ({
  version: 1,
  routineState: cloneRoutineState(input.routineState),
  pendingClarification: clonePending(input.pendingClarification),
  directiveState: cloneDirectiveState(input.directiveState),
});

export const importTestExecutionReplayContinuation = (
  value: unknown,
  sessionId: string,
): { routineState: RoutineState | null; pendingClarification: PendingClarification | null; directiveState: DirectiveFiringState | null } => {
  if (value === null) return { routineState: null, pendingClarification: null, directiveState: null };
  if (!isRecord(value) || value.version !== 1) return invalid();
  const routineState = parseRoutineState(value.routineState);
  const pendingClarification = parsePending(value.pendingClarification);
  return {
    routineState: routineState ? { ...routineState, sessionId } : null,
    pendingClarification: pendingClarification ? { ...pendingClarification, sessionId } : null,
    directiveState: parseDirectiveState(value.directiveState),
  };
};
