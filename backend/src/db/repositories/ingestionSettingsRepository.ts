import type { Database } from "../../shared/infra/database.js";
import type {
  IngestionSettingsInput,
  IngestionSettingsRecord,
} from "../../modules/settings/contracts/ingestion.js";
import type { IngestionSettingsRepositoryPort } from "../../modules/settings/contracts/services.js";

interface IngestionSettingsRow {
  workspace_id: string;
  chunking_strategy: IngestionSettingsRecord["chunkingStrategy"];
  fixed_window_chunk_size: number;
  fixed_window_chunk_overlap: number;
  structured_min_chunk_size: number;
  structured_max_chunk_size: number;
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
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

export class IngestionSettingsRepository implements IngestionSettingsRepositoryPort {
  constructor(private readonly database: Database) {}

  async findByWorkspaceId(workspaceId: string): Promise<IngestionSettingsRecord | null> {
    const [row] = await this.database.query<IngestionSettingsRow>(
      `SELECT workspace_id, chunking_strategy, fixed_window_chunk_size, fixed_window_chunk_overlap,
              structured_min_chunk_size, structured_max_chunk_size, created_at, updated_at
       FROM ingestion_settings
       WHERE workspace_id = $1`,
      [workspaceId],
    );

    return row ? mapSettings(row) : null;
  }

  async upsert(workspaceId: string, input: IngestionSettingsInput): Promise<IngestionSettingsRecord> {
    const [row] = await this.database.query<IngestionSettingsRow>(
      `INSERT INTO ingestion_settings (
         workspace_id,
         chunking_strategy,
         fixed_window_chunk_size,
         fixed_window_chunk_overlap,
         structured_min_chunk_size,
         structured_max_chunk_size
       )
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (workspace_id)
       DO UPDATE SET chunking_strategy = EXCLUDED.chunking_strategy,
                     fixed_window_chunk_size = EXCLUDED.fixed_window_chunk_size,
                     fixed_window_chunk_overlap = EXCLUDED.fixed_window_chunk_overlap,
                     structured_min_chunk_size = EXCLUDED.structured_min_chunk_size,
                     structured_max_chunk_size = EXCLUDED.structured_max_chunk_size,
                     updated_at = NOW()
       RETURNING workspace_id, chunking_strategy, fixed_window_chunk_size, fixed_window_chunk_overlap,
                 structured_min_chunk_size, structured_max_chunk_size, created_at, updated_at`,
      [
        workspaceId,
        input.chunkingStrategy,
        input.fixedWindowChunkSize,
        input.fixedWindowChunkOverlap,
        input.structuredMinChunkSize,
        input.structuredMaxChunkSize,
      ],
    );

    return mapSettings(row);
  }
}
