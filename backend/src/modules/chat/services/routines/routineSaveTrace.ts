import type { RoutineRunTrace } from "@radioso/conversation-contract";

import type { AuditEventInput } from "../../../audit/contracts/index.js";
import type { CapturedRoutineTransition } from "./deferredRoutineStore.js";

/** One save a routine's run trace records: keys, names, scope and outcome, never a value. */
type RoutineTraceSave = NonNullable<RoutineRunTrace["saves"]>[number];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** The stage with the routine's `saves` added: on its `routine` sub-trace, or its outputs when it has none. */
const stageWithSaves = (stage: Record<string, unknown>, saves: readonly RoutineTraceSave[]): Record<string, unknown> => {
  const subTrace = stage.subTrace;
  if (isRecord(subTrace) && subTrace.namespace === "routine" && isRecord(subTrace.payload)) {
    return { ...stage, subTrace: { ...subTrace, payload: { ...subTrace.payload, saves } } };
  }
  return { ...stage, outputs: { ...(isRecord(stage.outputs) ? stage.outputs : {}), saves } };
};

/** The index of the last stage that ran `routineId`, -1 when none did. */
const lastStageOf = (stages: readonly unknown[], routineId: string): number => {
  for (let index = stages.length - 1; index >= 0; index -= 1) {
    const stage = stages[index];
    if (isRecord(stage) && isRecord(stage.outputs) && stage.outputs.routineId === routineId) return index;
  }
  return -1;
};

/**
 * A turn trace with what its ending routine's saves did (#1884), written onto that routine's last
 * stage: its `routine` sub-trace when the engine ran it, the stage's outputs when a decision's resume
 * or a correction recorded it. Keys, names, scopes and outcomes only, never a value. The trace is
 * returned as it was when no stage names the routine.
 */
const withRoutineSavesOnTrace = <T>(turnTrace: T, routineId: string, saves: readonly RoutineTraceSave[]): T => {
  const spine = isRecord(turnTrace) ? turnTrace.spine : undefined;
  const stages = isRecord(spine) && Array.isArray(spine.stages) ? spine.stages as unknown[] : null;
  if (saves.length === 0 || !stages || !isRecord(turnTrace) || !isRecord(spine)) return turnTrace;
  const index = lastStageOf(stages, routineId);
  if (index < 0) return turnTrace;
  const patched = stages.map((stage, at) => (at === index ? stageWithSaves(stage as Record<string, unknown>, saves) : stage));
  return { ...turnTrace, spine: { ...spine, stages: patched } };
};

/** The turn's audit event with what its ending routine's saves did, on the routine's stage of its trace. */
export const withRoutineSaveTrace = (
  auditEvent: AuditEventInput,
  routineId: string,
  saves: readonly RoutineTraceSave[],
): AuditEventInput => {
  const turnTrace = auditEvent.metadata?.turnTrace;
  const traced = withRoutineSavesOnTrace(turnTrace, routineId, saves);
  return traced === turnTrace ? auditEvent : { ...auditEvent, metadata: { ...auditEvent.metadata, turnTrace: traced } };
};

/** The saves a turn that writes no attributes shows: each target and scope, `not_saved_in_test`. */
const unwrittenSaves = (transition: CapturedRoutineTransition | null | undefined): { routineId: string; saves: RoutineTraceSave[] } | null =>
  transition?.kind === "save" && transition.slotSaves?.length
    ? {
      routineId: transition.state.routineId,
      saves: transition.slotSaves.map((save) => ({ slotKey: save.slotKey, contextVariable: save.contextVariable, scope: save.scope, outcome: "not_saved_in_test" })),
    }
    : null;

/**
 * What a turn that writes no attributes persists (#1884): a safe_test turn, as an agent turn probe
 * runs, keeps its routine state but none of its saves, and its trace shows where each would have
 * gone, never the value.
 */
export const withRoutineSavesUnwritten = (
  transition: CapturedRoutineTransition | null | undefined,
  auditEvent: AuditEventInput,
): { transition: CapturedRoutineTransition | null | undefined; auditEvent: AuditEventInput } => {
  const unwritten = unwrittenSaves(transition);
  if (!unwritten || transition?.kind !== "save") return { transition, auditEvent };
  const { slotSaves: _unwritten, ...kept } = transition;
  return { transition: kept, auditEvent: withRoutineSaveTrace(auditEvent, unwritten.routineId, unwritten.saves) };
};

/**
 * A replayed turn's trace with its routine's saves shown as not saved: a Test Chat side or a replay
 * keeps no attribute store a routine writes to, so the trace shows each target, never the value.
 */
export const withUnwrittenRoutineSavesOnTrace = <T>(turnTrace: T, transition: CapturedRoutineTransition | null | undefined): T => {
  const unwritten = unwrittenSaves(transition);
  return unwritten ? withRoutineSavesOnTrace(turnTrace, unwritten.routineId, unwritten.saves) : turnTrace;
};
