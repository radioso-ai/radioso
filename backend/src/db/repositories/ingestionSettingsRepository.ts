import type {
  IngestionSettingsRecord,
  ValidatedIngestionSettingsInput,
} from "../../modules/settings/contracts/ingestion.js";
import type { IngestionSettingsRepositoryPort } from "../../modules/settings/contracts/services.js";
import { currentTimestamp } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";

interface IngestionSettingsRow {
  workspace_id: string;
  chunking_strategy: IngestionSettingsRecord["chunkingStrategy"];
  fixed_window_chunk_size: number;
  fixed_window_chunk_overlap: number;
  structured_min_chunk_size: number;
  structured_max_chunk_size: number;
  embedding_model: IngestionSettingsRecord["embeddingModel"];
  pending_embedding_model: IngestionSettingsRecord["pendingEmbeddingModel"];
  document_enrichment_enabled: boolean;
  revision: string;
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
  documentEnrichmentEnabled: row.document_enrichment_enabled,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

const ingestionSettingsColumns = [
  "workspace_id",
  "chunking_strategy",
  "fixed_window_chunk_size",
  "fixed_window_chunk_overlap",
  "structured_min_chunk_size",
  "structured_max_chunk_size",
  "embedding_model",
  "pending_embedding_model",
  "document_enrichment_enabled",
  "revision",
  "created_at",
  "updated_at",
] as const;

export class IngestionSettingsRepository implements IngestionSettingsRepositoryPort {
  constructor(private readonly db: Db) {}

  async findByWorkspaceId(workspaceId: string): Promise<IngestionSettingsRecord | null> {
    const row = await this.db
      .selectFrom("ingestion_settings")
      .select(ingestionSettingsColumns)
      .where("workspace_id", "=", workspaceId)
      .executeTakeFirst();

    return row ? mapSettings(row as IngestionSettingsRow) : null;
  }

  async findVersionedByWorkspaceId(workspaceId: string): Promise<{
    settings: IngestionSettingsRecord;
    revision: string;
  } | null> {
    const row = await this.db
      .selectFrom("ingestion_settings")
      .select(ingestionSettingsColumns)
      .where("workspace_id", "=", workspaceId)
      .executeTakeFirst();
    if (!row) {
      return null;
    }
    const versioned = row as IngestionSettingsRow;
    return {
      settings: mapSettings(versioned),
      revision: String(versioned.revision),
    };
  }

  async upsert(workspaceId: string, input: ValidatedIngestionSettingsInput): Promise<IngestionSettingsRecord> {
    const row = await this.db
      .insertInto("ingestion_settings")
      .values({
        workspace_id: workspaceId,
        chunking_strategy: input.chunkingStrategy,
        fixed_window_chunk_size: input.fixedWindowChunkSize,
        fixed_window_chunk_overlap: input.fixedWindowChunkOverlap,
        structured_min_chunk_size: input.structuredMinChunkSize,
        structured_max_chunk_size: input.structuredMaxChunkSize,
        embedding_model: input.embeddingModel,
        pending_embedding_model: input.pendingEmbeddingModel,
        document_enrichment_enabled: input.documentEnrichmentEnabled,
      })
      .onConflict((oc) =>
        oc.column("workspace_id").doUpdateSet((eb) => ({
          chunking_strategy: eb.ref("excluded.chunking_strategy"),
          fixed_window_chunk_size: eb.ref("excluded.fixed_window_chunk_size"),
          fixed_window_chunk_overlap: eb.ref("excluded.fixed_window_chunk_overlap"),
          structured_min_chunk_size: eb.ref("excluded.structured_min_chunk_size"),
          structured_max_chunk_size: eb.ref("excluded.structured_max_chunk_size"),
          embedding_model: eb.ref("excluded.embedding_model"),
          pending_embedding_model: eb.ref("excluded.pending_embedding_model"),
          document_enrichment_enabled: eb.ref("excluded.document_enrichment_enabled"),
          revision: eb("ingestion_settings.revision", "+", "1"),
          updated_at: currentTimestamp(),
        })),
      )
      .returning(ingestionSettingsColumns)
      .executeTakeFirstOrThrow();

    return mapSettings(row as IngestionSettingsRow);
  }

  async clearPendingEmbeddingModel(
    workspaceId: string,
    expectedPendingEmbeddingModel: NonNullable<
      IngestionSettingsRecord["pendingEmbeddingModel"]
    >,
    expectedRevision: string,
  ): Promise<IngestionSettingsRecord | null> {
    const row = await this.db
      .updateTable("ingestion_settings")
      .set((eb) => ({
        pending_embedding_model: null,
        revision: eb("revision", "+", "1"),
        updated_at: currentTimestamp(),
      }))
      .where("workspace_id", "=", workspaceId)
      .where("pending_embedding_model", "=", expectedPendingEmbeddingModel)
      .where("revision", "=", expectedRevision)
      .returning(ingestionSettingsColumns)
      .executeTakeFirst();

    return row ? mapSettings(row as IngestionSettingsRow) : null;
  }

  async promotePendingEmbeddingModelIfReady(workspaceId: string): Promise<IngestionSettingsRecord | null> {
    return this.db.transaction().execute(async (trx) => {
      const settings = await trx
        .selectFrom("ingestion_settings")
        .select(ingestionSettingsColumns)
        .where("workspace_id", "=", workspaceId)
        .forUpdate()
        .executeTakeFirst();
      const pendingModel = settings?.pending_embedding_model;

      if (!settings || !pendingModel) {
        return settings ? mapSettings(settings as IngestionSettingsRow) : null;
      }

      const row = await trx
        .selectFrom("documents as d")
        .select((eb) => [
          eb.fn
            .countAll<number>()
            .filterWhere("d.status", "in", ["queued", "processing"])
            .as("pending_document_count"),
          eb.fn
            .countAll<number>()
            .filterWhere("d.status", "=", "ready")
            .filterWhere(
              eb.exists(
                eb
                  .selectFrom("chunks as c")
                  .select("c.id")
                  .whereRef("c.document_id", "=", "d.id")
                  .whereRef("c.workspace_id", "=", "d.workspace_id")
                  .where("c.embedding_model", "is distinct from", pendingModel),
              ),
            )
            .as("mismatched_ready_document_count"),
        ])
        .where("d.workspace_id", "=", workspaceId)
        .executeTakeFirst();
      const hasPendingDocuments = Number(row?.pending_document_count ?? "0") > 0;
      const hasMismatchedReadyDocuments = Number(row?.mismatched_ready_document_count ?? "0") > 0;

      if (hasPendingDocuments || hasMismatchedReadyDocuments) {
        return mapSettings(settings as IngestionSettingsRow);
      }

      const promoted = await trx
        .updateTable("ingestion_settings")
        .set((eb) => ({
          embedding_model: eb.fn.coalesce("pending_embedding_model", "embedding_model"),
          pending_embedding_model: null,
          revision: eb("revision", "+", "1"),
          updated_at: currentTimestamp(),
        }))
        .where("workspace_id", "=", workspaceId)
        .returning(ingestionSettingsColumns)
        .executeTakeFirst();

      return promoted ? mapSettings(promoted as IngestionSettingsRow) : null;
    });
  }
}
