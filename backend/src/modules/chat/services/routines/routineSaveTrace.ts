import type { RoutineRunTrace } from "@radioso/conversation-contract";

import type { AuditEventInput } from "../../../audit/contracts/index.js";

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
 * The turn's audit event with what its ending routine's saves did (#1884), written onto that
 * routine's last stage in the turn's trace: its `routine` sub-trace when the engine ran it, the
 * stage's outputs when a decision's resume recorded it. Keys, names, scopes and outcomes only, never
 * a value. The event is returned as it was when no stage names the routine.
 */
export const withRoutineSaveTrace = (
  auditEvent: AuditEventInput,
  routineId: string,
  saves: readonly RoutineTraceSave[],
): AuditEventInput => {
  const turnTrace = auditEvent.metadata?.turnTrace;
  const spine = isRecord(turnTrace) ? turnTrace.spine : undefined;
  const stages = isRecord(spine) && Array.isArray(spine.stages) ? spine.stages as unknown[] : null;
  if (saves.length === 0 || !stages || !isRecord(turnTrace) || !isRecord(spine)) return auditEvent;
  const index = lastStageOf(stages, routineId);
  if (index < 0) return auditEvent;
  const patched = stages.map((stage, at) => (at === index ? stageWithSaves(stage as Record<string, unknown>, saves) : stage));
  return { ...auditEvent, metadata: { ...auditEvent.metadata, turnTrace: { ...turnTrace, spine: { ...spine, stages: patched } } } };
};
