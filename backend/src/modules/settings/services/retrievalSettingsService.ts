import {
  defaultRetrievalSettings,
  type AnswerSupportPolicy,
  type RetrievalSettingsRecord,
  type MetadataFieldSuggestion,
  normalizeMetadataRules,
  type RetrievalSettingsInput,
  validateRetrievalSettings,
} from "../domain/retrievalSettings.js";
import type { AuditService } from "../../audit/services/auditService.js";
import {
  NoopProductAnalyticsService,
  type ProductAnalyticsPort,
} from "../../../shared/analytics/productAnalyticsService.js";

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
    private readonly productAnalyticsService: ProductAnalyticsPort = new NoopProductAnalyticsService(),
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
      return this.disableRewriteAndStrictFactChecking({
        ...existing,
        ...normalized,
      });
    }

    const defaults = defaultRetrievalSettings(workspaceId);
    return this.repository.upsert(workspaceId, defaults);
  }

  async updateForWorkspace(workspaceId: string, input: RetrievalSettingsInput): Promise<RetrievalSettingsRecord> {
    try {
      const runtimeInput = this.disableRewriteAndStrictFactChecking({
        ...input,
        metadataRules: normalizeMetadataRules(input.metadataRules),
      });
      const normalizedInput: RetrievalSettingsInput = {
        ...runtimeInput,
        answerSupportPolicy: runtimeInput.answerSupportPolicy,
      };
      const settings = await this.repository.upsert(workspaceId, validateRetrievalSettings(normalizedInput));
      try {
        await this.auditService.record({
          workspaceId,
          eventType: "settings.update",
          eventStatus: "success",
        });
      } catch {
        // Audit logging must not turn a successful settings save into a 500.
      }
      try {
        await this.productAnalyticsService.track({
          eventName: "retrieval_settings.updated",
          workspaceId,
          subjectType: "settings",
          subjectId: workspaceId,
          properties: {
            queryRewriteEnabled: settings.queryRewriteEnabled,
            conversationMode: settings.conversationMode,
            answerSupportPolicy: settings.answerSupportPolicy,
            rerankEnabled: settings.rerankEnabled,
            suggestedQuestionsEnabled: settings.suggestedQuestionsEnabled,
          },
          source: "backend",
        });
      } catch {
        // Analytics fan-out must not turn a successful settings save into a 500.
      }
      return settings;
    } catch (error) {
      try {
        await this.auditService.record({
          workspaceId,
          eventType: "settings.update",
          eventStatus: "failure",
        });
      } catch {
        // Preserve the original write failure if failure-audit logging also breaks.
      }
      throw error;
    }
  }

  private disableRewriteAndStrictFactChecking<
    T extends Pick<RetrievalSettingsRecord, "queryRewriteEnabled" | "answerSupportPolicy" | "metadataRules">,
  >(input: T): T {
    return {
      ...input,
      queryRewriteEnabled: false,
      answerSupportPolicy: "off" as AnswerSupportPolicy,
      metadataRules: normalizeMetadataRules(input.metadataRules),
    };
  }
}
