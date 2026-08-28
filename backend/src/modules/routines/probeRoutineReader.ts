import { AppError } from "../../shared/domain/errors.js";
import type { RoutineDefinitionService } from "./service.js";

/** Minimal routines-owned lookup for selecting eligible unpublished routine previews. */
export interface ProbeRoutineReadPort {
  findPreviewRoutine(workspaceId: string, agentId: string, routineId: string): Promise<{
    status: "draft" | "published" | "superseded" | "archived";
  } | null>;
}

export class ProbeRoutineReader implements ProbeRoutineReadPort {
  constructor(private readonly routines: Pick<RoutineDefinitionService, "get">) {}

  async findPreviewRoutine(workspaceId: string, agentId: string, routineId: string) {
    try {
      return await this.routines.get(workspaceId, agentId, routineId);
    } catch (error) {
      if (error instanceof AppError && error.statusCode === 404) return null;
      throw error;
    }
  }
}
