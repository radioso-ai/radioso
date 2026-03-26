import {
  definitionsFromPolicies,
  defaultRetrievalSettings,
  mergeSignalDefinitions,
  normalizeSignalPolicies,
  builtInRetrievalSignalDefinitions,
  type RetrievalSignalDefinition,
  type RetrievalSettingsInput,
  type RetrievalSettingsRecord,
  validateRetrievalSettings,
} from "../domain/retrievalSettings.js";
import type { AuditService } from "../../audit/services/auditService.js";

export interface RetrievalSettingsRepositoryPort {
  findByWorkspaceId(workspaceId: string): Promise<RetrievalSettingsRecord | null>;
  upsert(workspaceId: string, input: RetrievalSettingsInput): Promise<RetrievalSettingsRecord>;
}

export interface RetrievalSignalDefinitionSourcePort {
  listMetadataSignalDefinitions(workspaceId: string): Promise<RetrievalSignalDefinition[]>;
}

export class RetrievalSettingsService {
  constructor(
    private readonly repository: RetrievalSettingsRepositoryPort,
    private readonly auditService: AuditService,
    private readonly signalDefinitionSource?: RetrievalSignalDefinitionSourcePort,
  ) {}

  async listSignalDefinitions(workspaceId: string): Promise<RetrievalSignalDefinition[]> {
    const existing = await this.repository.findByWorkspaceId(workspaceId);
    return this.resolveSignalDefinitions(workspaceId, existing?.signalPolicies ?? []);
  }

  async getForWorkspace(workspaceId: string): Promise<RetrievalSettingsRecord> {
    const existing = await this.repository.findByWorkspaceId(workspaceId);
    const signalDefinitions = await this.resolveSignalDefinitions(workspaceId, existing?.signalPolicies ?? []);

    if (existing) {
      const normalized = validateRetrievalSettings({
        ...existing,
        signalPolicies: normalizeSignalPolicies(existing.signalPolicies, signalDefinitions),
      }, signalDefinitions);
      return {
        ...existing,
        ...normalized,
      };
    }

    const defaults = defaultRetrievalSettings(workspaceId, signalDefinitions);
    return this.repository.upsert(workspaceId, defaults);
  }

  async updateForWorkspace(workspaceId: string, input: RetrievalSettingsInput): Promise<RetrievalSettingsRecord> {
    try {
      const existing = await this.repository.findByWorkspaceId(workspaceId);
      const signalDefinitions = await this.resolveSignalDefinitions(
        workspaceId,
        existing?.signalPolicies ?? [],
        input.signalPolicies,
      );
      const settings = await this.repository.upsert(workspaceId, validateRetrievalSettings(input, signalDefinitions));
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

  private async resolveSignalDefinitions(
    workspaceId: string,
    ...policyGroups: Array<{ signalKey: string }[]>
  ): Promise<RetrievalSignalDefinition[]> {
    const metadataDefinitions = this.signalDefinitionSource
      ? await this.signalDefinitionSource.listMetadataSignalDefinitions(workspaceId)
      : [];

    return mergeSignalDefinitions(
      builtInRetrievalSignalDefinitions,
      metadataDefinitions,
      ...policyGroups.map((policies) => definitionsFromPolicies(policies)),
    );
  }
}
