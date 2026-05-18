import type { Database } from "../../shared/infra/database.js";
import type {
  IngestionSettingsRecord,
  ValidatedIngestionSettingsInput,
} from "../../modules/settings/contracts/ingestion.js";
import type { IngestionSettingsRepositoryPort } from "../../modules/settings/contracts/services.js";

interface IngestionSettingsRow {
  workspace_id: string;
  chunking_strategy: IngestionSettingsRecord["chunkingStrategy"];
  fixed_window_chunk_size: number;
  fixed_window_chunk_overlap: number;
  structured_min_chunk_size: number;
  structured_max_chunk_size: number;
  embedding_model: IngestionSettingsRecord["embeddingModel"];
  pending_embedding_model: IngestionSettingsRecord["pendingEmbeddingModel"];
  created_at: Date;
  updated_at: Date;
}

const mapSettings = (row: IngestionSettingsRow): IngestionSettingsRecord => ({
  workspaceId: row.workspace_id,
  chunkingStrategy: row.chunking_strategy,
  fixedWindowChunkSize: row.fixed_window_chunk_size,
  fixedWindowChunkOverlap: row.fixed_window_chunk_overlap,
  structuredMinChunkSize: row.structured_min_chunk_size,
  structuredMaxChunkSize: row.structured_max_chunk_size,
  embeddingModel: row.embedding_model,
  pendingEmbeddingModel: row.pending_embedding_model,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

const ingestionSettingsColumns = `workspace_id, chunking_strategy, fixed_window_chunk_size, fixed_window_chunk_overlap,
              structured_min_chunk_size, structured_max_chunk_size, embedding_model, pending_embedding_model, created_at, updated_at`;

export class IngestionSettingsRepository implements IngestionSettingsRepositoryPort {
  constructor(private readonly database: Database) {}

  async findByWorkspaceId(workspaceId: string): Promise<IngestionSettingsRecord | null> {
    const row = await this.database.queryOptional<IngestionSettingsRow>(
      `SELECT ${ingestionSettingsColumns}
       FROM ingestion_settings
       WHERE workspace_id = $1`,
      [workspaceId],
    );

    return row ? mapSettings(row) : null;
  }

  async upsert(workspaceId: string, input: ValidatedIngestionSettingsInput): Promise<IngestionSettingsRecord> {
    const row = await this.database.queryOne<IngestionSettingsRow>(
      `INSERT INTO ingestion_settings (
         workspace_id,
         chunking_strategy,
         fixed_window_chunk_size,
         fixed_window_chunk_overlap,
         structured_min_chunk_size,
         structured_max_chunk_size,
         embedding_model,
         pending_embedding_model
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (workspace_id)
       DO UPDATE SET chunking_strategy = EXCLUDED.chunking_strategy,
                     fixed_window_chunk_size = EXCLUDED.fixed_window_chunk_size,
                     fixed_window_chunk_overlap = EXCLUDED.fixed_window_chunk_overlap,
                     structured_min_chunk_size = EXCLUDED.structured_min_chunk_size,
                     structured_max_chunk_size = EXCLUDED.structured_max_chunk_size,
                     embedding_model = EXCLUDED.embedding_model,
                     pending_embedding_model = EXCLUDED.pending_embedding_model,
                     updated_at = NOW()
       RETURNING ${ingestionSettingsColumns}`,
      [
        workspaceId,
        input.chunkingStrategy,
        input.fixedWindowChunkSize,
        input.fixedWindowChunkOverlap,
        input.structuredMinChunkSize,
        input.structuredMaxChunkSize,
        input.embeddingModel,
        input.pendingEmbeddingModel,
      ],
    );

    return mapSettings(row);
  }

  async clearPendingEmbeddingModel(workspaceId: string): Promise<IngestionSettingsRecord | null> {
    const row = await this.database.queryOptional<IngestionSettingsRow>(
      `UPDATE ingestion_settings
       SET pending_embedding_model = NULL,
           updated_at = NOW()
       WHERE workspace_id = $1
       RETURNING ${ingestionSettingsColumns}`,
      [workspaceId],
    );

    return row ? mapSettings(row) : null;
  }

  async promotePendingEmbeddingModelIfReady(workspaceId: string): Promise<IngestionSettingsRecord | null> {
    return this.database.withTransaction(async (client) => {
      const settingsResult = await client.query<IngestionSettingsRow>(
        `SELECT ${ingestionSettingsColumns}
         FROM ingestion_settings
         WHERE workspace_id = $1
         FOR UPDATE`,
        [workspaceId],
      );
      const settings = settingsResult.rows[0];
      const pendingModel = settings?.pending_embedding_model;

      if (!settings || !pendingModel) {
        return settings ? mapSettings(settings) : null;
      }

      const readiness = await client.query<{ pending_document_count: string; mismatched_ready_document_count: string }>(
        `SELECT
           COUNT(*) FILTER (WHERE d.status IN ('queued', 'processing'))::text AS pending_document_count,
           COUNT(*) FILTER (
             WHERE d.status = 'ready'
               AND EXISTS (
                 SELECT 1
                 FROM chunks c
                 WHERE c.document_id = d.id
                   AND c.workspace_id = d.workspace_id
                   AND c.embedding_model IS DISTINCT FROM $2
               )
           )::text AS mismatched_ready_document_count
         FROM documents d
         WHERE d.workspace_id = $1`,
        [workspaceId, pendingModel],
      );
      const row = readiness.rows[0];
      const hasPendingDocuments = Number(row?.pending_document_count ?? "0") > 0;
      const hasMismatchedReadyDocuments = Number(row?.mismatched_ready_document_count ?? "0") > 0;

      if (hasPendingDocuments || hasMismatchedReadyDocuments) {
        return mapSettings(settings);
      }

      const promoted = await client.query<IngestionSettingsRow>(
        `UPDATE ingestion_settings
         SET embedding_model = pending_embedding_model,
             pending_embedding_model = NULL,
             updated_at = NOW()
         WHERE workspace_id = $1
         RETURNING ${ingestionSettingsColumns}`,
        [workspaceId],
      );

      return promoted.rows[0] ? mapSettings(promoted.rows[0]) : null;
    });
  }
}
