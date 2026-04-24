import {
  defaultRetrievalSettings,
  type MetadataFieldSuggestion,
  normalizeMetadataRules,
  type RetrievalSettingsInput,
  type RetrievalSettingsRecord,
  validateRetrievalSettings,
} from "../domain/retrievalSettings.js";
import type { AuditService } from "../../audit/services/auditService.js";
import {
  NoopProductAnalyticsService,
  type ProductAnalyticsPort,
} from "../../../shared/analytics/productAnalyticsService.js";
import { loadPromptTemplate } from "../../../shared/infra/prompts/promptLoader.js";

const FIXED_SEMANTIC_REWRITE_INSTRUCTIONS = loadPromptTemplate("retrieval/semantic-rewrite-instructions.md");
const FIXED_LEXICAL_REWRITE_INSTRUCTIONS = loadPromptTemplate("retrieval/lexical-rewrite-instructions.md");
const FIXED_ANSWER_SUPPORT_POLICY = "strict" as const;

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
        semanticRewriteInstructions: FIXED_SEMANTIC_REWRITE_INSTRUCTIONS,
        lexicalRewriteInstructions: FIXED_LEXICAL_REWRITE_INSTRUCTIONS,
        answerSupportPolicy: FIXED_ANSWER_SUPPORT_POLICY,
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
      const normalizedInput: RetrievalSettingsInput = {
        ...input,
        semanticRewriteInstructions: FIXED_SEMANTIC_REWRITE_INSTRUCTIONS,
        lexicalRewriteInstructions: FIXED_LEXICAL_REWRITE_INSTRUCTIONS,
        answerSupportPolicy: FIXED_ANSWER_SUPPORT_POLICY,
        metadataRules: normalizeMetadataRules(input.metadataRules),
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
}
