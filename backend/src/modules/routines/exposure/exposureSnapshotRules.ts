import type { RoutineDefinition } from "../domain.js";
import type { RoutineValidationDiagnostic } from "../validator.js";

interface RoutineExposureSnapshotDiagnostic extends RoutineValidationDiagnostic {
  routineId: string;
}

type ExposureRoutine = Pick<RoutineDefinition, "id" | "lineageId" | "enabled" | "exposure">;

const publishedToolName = (routine: ExposureRoutine): string | null => {
  const toolName = routine.exposure?.toolName ?? "";
  return toolName.length > 0 ? toolName : null;
};

/**
 * The rules that only hold across a whole revision snapshot, checked at candidate creation
 * and publish (`assertCandidateSnapshotIsRunnable`), where the per-definition validator has
 * no view of sibling routines or of what the agent already published:
 *
 * - Two routines that can both serve (`enabled`) cannot offer the same tool name; a parked
 *   routine's exposure is inert, the same way its structural diagnostics are skipped.
 * - A tool name is frozen for its lineage from the first published revision that carries
 *   it — while later disabled too, so a calling agent's catalog never sees one routine under
 *   two names. Renaming means a new routine.
 */
export const validateExposureAcrossSnapshot = (
  routines: ReadonlyArray<ExposureRoutine>,
  previouslyPublished: ReadonlyArray<ExposureRoutine> = [],
): RoutineExposureSnapshotDiagnostic[] => {
  const diagnostics: RoutineExposureSnapshotDiagnostic[] = [];

  const serving = routines.filter((routine) => routine.enabled && routine.exposure?.enabled);
  const routinesByToolName = new Map<string, ExposureRoutine[]>();
  for (const routine of serving) {
    const toolName = routine.exposure!.toolName;
    routinesByToolName.set(toolName, [...(routinesByToolName.get(toolName) ?? []), routine]);
  }
  for (const routine of serving) {
    const toolName = routine.exposure!.toolName;
    if ((routinesByToolName.get(toolName)?.length ?? 0) > 1) {
      diagnostics.push({
        routineId: routine.id,
        code: "exposure_tool_name_duplicate",
        location: "exposure.toolName",
        message: `duplicate tool name: "${toolName}" is offered by more than one routine of this agent; each exposed routine needs its own name.`,
      });
    }
  }

  const frozenByLineage = new Map<string, string>();
  for (const routine of previouslyPublished) {
    const toolName = publishedToolName(routine);
    if (toolName) frozenByLineage.set(routine.lineageId, toolName);
  }
  for (const routine of routines) {
    const frozen = frozenByLineage.get(routine.lineageId);
    if (frozen === undefined) continue;
    if (routine.exposure?.toolName !== frozen) {
      diagnostics.push({
        routineId: routine.id,
        code: "exposure_tool_name_changed",
        location: "exposure.toolName",
        message: `tool name changed: this routine was published as "${frozen}", and a published tool name cannot change; keep "${frozen}", or disable this exposure and create a new routine for the new name.`,
      });
    }
  }

  return diagnostics;
};
