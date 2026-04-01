import {
  defaultIngestionSettings,
  type IngestionSettingsInput,
  type IngestionSettingsRecord,
  validateIngestionSettings,
} from "../domain/ingestionSettings.js";
import type { AuditService } from "../../audit/services/auditService.js";

export interface IngestionSettingsRepositoryPort {
  findByWorkspaceId(workspaceId: string): Promise<IngestionSettingsRecord | null>;
  upsert(workspaceId: string, input: IngestionSettingsInput): Promise<IngestionSettingsRecord>;
}

export class IngestionSettingsService {
  constructor(
    private readonly repository: IngestionSettingsRepositoryPort,
    private readonly auditService: AuditService,
  ) {}

  async getForWorkspace(workspaceId: string): Promise<IngestionSettingsRecord> {
    const existing = await this.repository.findByWorkspaceId(workspaceId);
    if (existing) {
      return {
        ...existing,
        ...validateIngestionSettings(existing),
      };
    }

    const defaults = defaultIngestionSettings(workspaceId);
    return this.repository.upsert(workspaceId, defaults);
  }

  async updateForWorkspace(workspaceId: string, input: IngestionSettingsInput): Promise<IngestionSettingsRecord> {
    try {
      const settings = await this.repository.upsert(workspaceId, validateIngestionSettings(input));
      try {
        await this.auditService.record({
          workspaceId,
          eventType: "ingestion_settings.update",
          eventStatus: "success",
        });
      } catch {
        // Audit logging must not turn a successful settings save into a 500.
      }
      return settings;
    } catch (error) {
      try {
        await this.auditService.record({
          workspaceId,
          eventType: "ingestion_settings.update",
          eventStatus: "failure",
        });
      } catch {
        // Preserve the original write failure if failure-audit logging also breaks.
      }
      throw error;
    }
  }
}
