import type { Database } from "../../shared/infra/database.js";
import type {
  RetrievalSettingsInput,
  RetrievalSettingsRecord,
} from "../../modules/settings/contracts/retrieval.js";
import {
  DEFAULT_RETRIEVAL_STRATEGY_PREFERENCE,
  DEFAULT_SUGGESTED_QUESTIONS_COUNT,
  DEFAULT_SUGGESTED_QUESTIONS_ENABLED,
  normalizeMetadataRules,
  resolveRetrievalStrategyPreference,
} from "../../modules/settings/contracts/retrieval.js";
import type {
  RetrievalSettingsRepositoryPort,
  WorkspaceLlmCapabilityPreferencesRepositoryPort,
} from "../../modules/settings/contracts/services.js";
import {
  workspaceLlmCapabilities,
  type WorkspaceLlmCapability,
  type WorkspaceLlmCapabilityPreference,
  type WorkspaceLlmCapabilityPreferenceInput,
} from "../../modules/settings/contracts/llmCapability.js";
import type { LlmProviderName } from "../../shared/infra/llm/providerTypes.js";

interface CapabilityColumnRow {
  workspace_id: string;
  chat_provider: LlmProviderName | null;
  chat_model: string | null;
  rewrite_provider: LlmProviderName | null;
  rewrite_model: string | null;
  rerank_provider: LlmProviderName | null;
  rerank_model: string | null;
  updated_at: Date;
}

const capabilityColumnPairs: Record<WorkspaceLlmCapability, { provider: keyof CapabilityColumnRow; model: keyof CapabilityColumnRow }> = {
  chat: { provider: "chat_provider", model: "chat_model" },
  rewrite: { provider: "rewrite_provider", model: "rewrite_model" },
  rerank: { provider: "rerank_provider", model: "rerank_model" },
};

const toCapabilityPreferences = (
  row: CapabilityColumnRow,
): WorkspaceLlmCapabilityPreference[] =>
  workspaceLlmCapabilities
    .map((capability) => {
      const provider = row[capabilityColumnPairs[capability].provider];
      const model = row[capabilityColumnPairs[capability].model];
      if (typeof provider === "string" && typeof model === "string") {
        return {
          workspaceId: row.workspace_id,
          capability,
          provider: provider as LlmProviderName,
          model,
          updatedAt: new Date(row.updated_at),
        } satisfies WorkspaceLlmCapabilityPreference;
      }
      return null;
    })
    .filter((entry): entry is WorkspaceLlmCapabilityPreference => entry !== null);

interface RetrievalSettingsPayload {
  metadataRules?: unknown;
  semanticRewriteInstructions?: unknown;
  lexicalRewriteInstructions?: unknown;
  suggestedQuestionsEnabled?: unknown;
  suggestedQuestionsCount?: unknown;
  retrievalStrategy?: unknown;
}

interface RetrievalSettingsRow {
  workspace_id: string;
  query_rewrite_enabled: boolean;
  rerank_enabled: boolean;
  vector_top_k: number;
  similarity_threshold: number;
  rerank_top_k: number;
  citation_display_enabled: boolean;
  attribute_controls: unknown;
  custom_instruction: string;
  created_at: Date;
  updated_at: Date;
}

const mapSettings = (row: RetrievalSettingsRow): RetrievalSettingsRecord => {
  const payload =
    row.attribute_controls && typeof row.attribute_controls === "object"
      ? (row.attribute_controls as RetrievalSettingsPayload)
      : {};

  return {
    workspaceId: row.workspace_id,
    queryRewriteEnabled: row.query_rewrite_enabled,
    semanticRewriteInstructions:
      typeof payload.semanticRewriteInstructions === "string" ? payload.semanticRewriteInstructions : "",
    lexicalRewriteInstructions:
      typeof payload.lexicalRewriteInstructions === "string" ? payload.lexicalRewriteInstructions : "",
    suggestedQuestionsEnabled:
      typeof payload.suggestedQuestionsEnabled === "boolean"
        ? payload.suggestedQuestionsEnabled
        : DEFAULT_SUGGESTED_QUESTIONS_ENABLED,
    suggestedQuestionsCount:
      typeof payload.suggestedQuestionsCount === "number" && Number.isInteger(payload.suggestedQuestionsCount)
        ? payload.suggestedQuestionsCount
        : DEFAULT_SUGGESTED_QUESTIONS_COUNT,
    rerankEnabled: row.rerank_enabled,
    vectorTopK: row.vector_top_k,
    similarityThreshold: row.similarity_threshold,
    rerankTopK: row.rerank_top_k,
    citationDisplayEnabled: row.citation_display_enabled,
    metadataRules: normalizeMetadataRules(payload.metadataRules),
    customInstruction: row.custom_instruction,
    retrievalStrategy:
      resolveRetrievalStrategyPreference(payload.retrievalStrategy) ??
      DEFAULT_RETRIEVAL_STRATEGY_PREFERENCE,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
};

export class RetrievalSettingsRepository
  implements RetrievalSettingsRepositoryPort, WorkspaceLlmCapabilityPreferencesRepositoryPort
{
  constructor(private readonly database: Database) {}

  async findByWorkspace(workspaceId: string): Promise<WorkspaceLlmCapabilityPreference[]> {
    const row = await this.database.queryOptional<CapabilityColumnRow>(
      `SELECT workspace_id, chat_provider, chat_model, rewrite_provider, rewrite_model, rerank_provider, rerank_model, updated_at
       FROM retrieval_settings
       WHERE workspace_id = $1`,
      [workspaceId],
    );
    return row ? toCapabilityPreferences(row) : [];
  }

  async setPreference(
    workspaceId: string,
    capability: WorkspaceLlmCapability,
    value: WorkspaceLlmCapabilityPreferenceInput | null,
  ): Promise<void> {
    const columns = capabilityColumnPairs[capability];
    const provider = value?.provider ?? null;
    const model = value?.model ?? null;
    const affected = await this.database.execute(
      `UPDATE retrieval_settings
       SET ${columns.provider} = $2,
           ${columns.model} = $3,
           updated_at = NOW()
       WHERE workspace_id = $1`,
      [workspaceId, provider, model],
    );
    if (affected === 0) {
      // No retrieval_settings row exists yet for this workspace; we cannot create one
      // here without forging non-capability defaults. The capability service guards
      // this case by ensuring the row exists before writing.
      throw new Error(`retrieval_settings row missing for workspace ${workspaceId}`);
    }
  }

  async findByWorkspaceId(workspaceId: string): Promise<RetrievalSettingsRecord | null> {
    const row = await this.database.queryOptional<RetrievalSettingsRow>(
      `SELECT workspace_id, query_rewrite_enabled, rerank_enabled, vector_top_k, similarity_threshold, rerank_top_k, citation_display_enabled, attribute_controls, custom_instruction, created_at, updated_at
       FROM retrieval_settings
       WHERE workspace_id = $1`,
      [workspaceId],
    );

    return row ? mapSettings(row) : null;
  }

  async upsert(workspaceId: string, input: RetrievalSettingsInput): Promise<RetrievalSettingsRecord> {
    const row = await this.database.queryOne<RetrievalSettingsRow>(
      `INSERT INTO retrieval_settings (
         workspace_id,
         query_rewrite_enabled,
         rerank_enabled,
         vector_top_k,
         similarity_threshold,
         rerank_top_k,
         warmth_level,
         citation_display_enabled,
         attribute_controls,
         custom_instruction
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
       ON CONFLICT (workspace_id)
       DO UPDATE SET query_rewrite_enabled = EXCLUDED.query_rewrite_enabled,
                     rerank_enabled = EXCLUDED.rerank_enabled,
                     vector_top_k = EXCLUDED.vector_top_k,
                     similarity_threshold = EXCLUDED.similarity_threshold,
                     rerank_top_k = EXCLUDED.rerank_top_k,
                     warmth_level = EXCLUDED.warmth_level,
                     citation_display_enabled = EXCLUDED.citation_display_enabled,
                     attribute_controls = EXCLUDED.attribute_controls,
                     custom_instruction = EXCLUDED.custom_instruction,
                     updated_at = NOW()
       RETURNING workspace_id, query_rewrite_enabled, rerank_enabled, vector_top_k, similarity_threshold, rerank_top_k, citation_display_enabled, attribute_controls, custom_instruction, created_at, updated_at`,
      [
        workspaceId,
        input.queryRewriteEnabled,
        input.rerankEnabled,
        input.vectorTopK,
        input.similarityThreshold,
        input.rerankTopK,
        5,
        input.citationDisplayEnabled,
        JSON.stringify({
          metadataRules: input.metadataRules,
          semanticRewriteInstructions: input.semanticRewriteInstructions,
          lexicalRewriteInstructions: input.lexicalRewriteInstructions,
          suggestedQuestionsEnabled: input.suggestedQuestionsEnabled,
          suggestedQuestionsCount: input.suggestedQuestionsCount,
          retrievalStrategy: input.retrievalStrategy ?? DEFAULT_RETRIEVAL_STRATEGY_PREFERENCE,
        }),
        input.customInstruction,
      ],
    );

    return mapSettings(row);
  }
}
