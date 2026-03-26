import {
  defaultRetrievalSettings,
  type MetadataFieldSuggestion,
  normalizeMetadataRules,
  type RetrievalSettingsInput,
  type RetrievalSettingsRecord,
  validateRetrievalSettings,
} from "../domain/retrievalSettings.js";
import type { AuditService } from "../../audit/services/auditService.js";

export interface RetrievalSettingsRepositoryPort {
  findByWorkspaceId(workspaceId: string): Promise<RetrievalSettingsRecord | null>;
  upsert(workspaceId: string, input: RetrievalSettingsInput): Promise<RetrievalSettingsRecord>;
}

export interface RetrievalMetadataFieldSourcePort {
  listMetadataFieldSuggestions(workspaceId: string): Promise<MetadataFieldSuggestion[]>;
}

export class RetrievalSettingsService {
  constructor(
    private readonly repository: RetrievalSettingsRepositoryPort,
    private readonly auditService: AuditService,
    private readonly metadataFieldSource?: RetrievalMetadataFieldSourcePort,
  ) {}

  async listMetadataFieldSuggestions(workspaceId: string): Promise<MetadataFieldSuggestion[]> {
    return this.metadataFieldSource ? this.metadataFieldSource.listMetadataFieldSuggestions(workspaceId) : [];
  }

  async getForWorkspace(workspaceId: string): Promise<RetrievalSettingsRecord> {
    const existing = await this.repository.findByWorkspaceId(workspaceId);

    if (existing) {
      const normalized = validateRetrievalSettings({
        ...existing,
        metadataRules: normalizeMetadataRules(existing.metadataRules),
      });
      return {
        ...existing,
        ...normalized,
      };
    }

    const defaults = defaultRetrievalSettings(workspaceId);
    return this.repository.upsert(workspaceId, defaults);
  }

  async updateForWorkspace(workspaceId: string, input: RetrievalSettingsInput): Promise<RetrievalSettingsRecord> {
    try {
      const settings = await this.repository.upsert(workspaceId, validateRetrievalSettings(input));
      await this.auditService.record({
        workspaceId,
        eventType: "settings.update",
        eventStatus: "success",
      });
      return settings;
    } catch (error) {
      await this.auditService.record({
        workspaceId,
        eventType: "settings.update",
        eventStatus: "failure",
      });
      throw error;
    }
  }
}
