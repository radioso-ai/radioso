import type { Database } from "../../shared/infra/database.js";
import type {
  RetrievalSettingsInput,
  RetrievalSettingsRecord,
} from "../../modules/settings/domain/retrievalSettings.js";
import { normalizeSignalPolicies } from "../../modules/settings/domain/retrievalSettings.js";
import type { RetrievalSettingsRepositoryPort } from "../../modules/settings/services/retrievalSettingsService.js";

interface RetrievalSettingsRow {
  workspace_id: string;
  query_rewrite_enabled: boolean;
  rerank_enabled: boolean;
  vector_top_k: number;
  similarity_threshold: number;
  rerank_top_k: number;
  warmth_level: number;
  citation_display_enabled: boolean;
  attribute_controls: unknown;
  custom_instruction: string;
  created_at: Date;
  updated_at: Date;
}

const mapSettings = (row: RetrievalSettingsRow): RetrievalSettingsRecord => ({
  workspaceId: row.workspace_id,
  queryRewriteEnabled: row.query_rewrite_enabled,
  rerankEnabled: row.rerank_enabled,
  vectorTopK: row.vector_top_k,
  similarityThreshold: row.similarity_threshold,
  rerankTopK: row.rerank_top_k,
  warmthLevel: row.warmth_level,
  citationDisplayEnabled: row.citation_display_enabled,
  signalPolicies: normalizeSignalPolicies(row.attribute_controls),
  customInstruction: row.custom_instruction,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

export class RetrievalSettingsRepository implements RetrievalSettingsRepositoryPort {
  constructor(private readonly database: Database) {}

  async findByWorkspaceId(workspaceId: string): Promise<RetrievalSettingsRecord | null> {
    const [row] = await this.database.query<RetrievalSettingsRow>(
      `SELECT workspace_id, query_rewrite_enabled, rerank_enabled, vector_top_k, similarity_threshold, rerank_top_k, warmth_level, citation_display_enabled, attribute_controls, custom_instruction, created_at, updated_at
       FROM retrieval_settings
       WHERE workspace_id = $1`,
      [workspaceId],
    );

    return row ? mapSettings(row) : null;
  }

  async upsert(workspaceId: string, input: RetrievalSettingsInput): Promise<RetrievalSettingsRecord> {
    const [row] = await this.database.query<RetrievalSettingsRow>(
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
       RETURNING workspace_id, query_rewrite_enabled, rerank_enabled, vector_top_k, similarity_threshold, rerank_top_k, warmth_level, citation_display_enabled, attribute_controls, custom_instruction, created_at, updated_at`,
      [
        workspaceId,
        input.queryRewriteEnabled,
        input.rerankEnabled,
        input.vectorTopK,
        input.similarityThreshold,
        input.rerankTopK,
        input.warmthLevel,
        input.citationDisplayEnabled,
        JSON.stringify(input.signalPolicies),
        input.customInstruction,
      ],
    );

    return mapSettings(row);
  }
}
