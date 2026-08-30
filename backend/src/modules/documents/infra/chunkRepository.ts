import type { EmbeddingSpaceRef } from "../../embeddingProfiles/contracts/embeddingConsumers.js";
import { insertCanonicalChunkEmbeddingsForDocumentRevision } from "../../../db/repositories/chunkEmbeddingRepository.js";
import { insertEmbeddingProfileJobsForDocumentRevision } from "../../../db/repositories/documentProcessingJobRepository.js";
import {
  appendVectorFilterUpdatesForDocumentTransaction,
  appendVectorTombstonesForDocumentTransaction,
} from "../../../db/repositories/vectorIndexWorkRepository.js";
import type { Database } from "../../../shared/infra/database.js";
import type {
  ChunkDetail,
  ChunkMetadataRevisionPatch,
  ChunkRecord,
  ChunkRepositoryPort,
  ChunkSummary,
  PublishedChunkRecord,
} from "../contracts/index.js";

const CHUNK_CONTENT_PREVIEW_MAX_CHARS = 240;
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";

interface QueryClient {
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

interface ChunkDetailRow {
  id: string;
  document_id: string;
  workspace_id: string;
  chunk_index: number;
  content: string;
  search_text: string | null;
  start_offset: number;
  end_offset: number;
  metadata: Record<string, unknown> | null;
  created_at: Date;
  embedding_dimensions: number | null;
  date_from: string | null;
  date_to: string | null;
}

const mapChunkDetail = (row: ChunkDetailRow): ChunkDetail => ({
  id: row.id,
  documentId: row.document_id,
  workspaceId: row.workspace_id,
  chunkIndex: Number(row.chunk_index),
  content: row.content,
  searchText: row.search_text,
  startOffset: Number(row.start_offset),
  endOffset: Number(row.end_offset),
  metadata: (row.metadata ?? {}) as Record<string, unknown>,
  dateFrom: row.date_from,
  dateTo: row.date_to,
  createdAt: row.created_at,
  embeddingDimensions: row.embedding_dimensions === null ? null : Number(row.embedding_dimensions),
});

// The chunk row carries text, offsets and metadata. Its vector is written separately
// into chunk_embeddings, which is what search compares against.
const CHUNK_INSERT_COLUMNS = 10;

const insertChunks = async (client: QueryClient, chunks: ChunkRecord[]): Promise<void> => {
  if (chunks.length === 0) {
    return;
  }

  const values: unknown[] = [];
  const placeholders = chunks.map((chunk, index) => {
    const offset = index * CHUNK_INSERT_COLUMNS;
    values.push(
      chunk.id,
      chunk.documentId,
      chunk.workspaceId,
      chunk.chunkIndex,
      chunk.content,
      chunk.searchText ?? chunk.content,
      chunk.embeddingModel ?? DEFAULT_EMBEDDING_MODEL,
      chunk.startOffset,
      chunk.endOffset,
      JSON.stringify(chunk.metadata ?? {}),
    );

    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}::jsonb)`;
  });
  await client.query(
    `INSERT INTO chunks (id, document_id, workspace_id, chunk_index, content, search_text, embedding_model, start_offset, end_offset, metadata)
     VALUES ${placeholders.join(", ")}`,
    values,
  );
};

export class ChunkRepository implements ChunkRepositoryPort {
  constructor(private readonly database: Database) {}

  async replaceForDocument(documentId: string, chunks: ChunkRecord[]): Promise<void> {
    await this.database.withTransaction(async (client) => {
      const workspaceId = chunks[0]?.workspaceId ?? (await lookupWorkspaceIdForDocument(client, documentId));
      await client.query("DELETE FROM chunks WHERE document_id = $1 AND workspace_id = $2", [documentId, workspaceId]);
      await insertChunks(client, chunks);
    });
  }

  async publishForDocumentRevision(input: {
    documentId: string;
    workspaceId: string;
    revision: number;
    chunks: ChunkRecord[];
    embeddingSpace: EmbeddingSpaceRef;
    canonicalVersion: string;
  }): Promise<boolean> {
    return this.database.withTransaction(async (client) => {
      const documentRows = await client.query<{ id: string }>(
        `SELECT id
         FROM documents
         WHERE id = $1
           AND workspace_id = $2
           AND revision = $3
         FOR UPDATE`,
        [input.documentId, input.workspaceId, input.revision],
      );

      if (documentRows.rows.length === 0) {
        return false;
      }

      await appendVectorTombstonesForDocumentTransaction(client, {
        workspaceId: input.workspaceId,
        documentId: input.documentId,
        retainedChunkIds: input.chunks.map((chunk) => chunk.id),
      });
      await client.query("DELETE FROM chunks WHERE document_id = $1 AND workspace_id = $2", [
        input.documentId,
        input.workspaceId,
      ]);
      await insertChunks(client, input.chunks);
      await insertEmbeddingProfileJobsForDocumentRevision(client, {
        workspaceId: input.workspaceId,
        documentId: input.documentId,
        documentRevision: input.revision,
        activeEmbeddingSpaceId: input.embeddingSpace.id,
      });
      await insertCanonicalChunkEmbeddingsForDocumentRevision(client, {
        workspaceId: input.workspaceId,
        documentId: input.documentId,
        documentRevision: input.revision,
        canonicalVersion: input.canonicalVersion,
        embeddingSpace: input.embeddingSpace,
        chunks: input.chunks,
      });
      await client.query(
        `UPDATE documents
         SET status = 'ready',
             failed_at = NULL,
             failure_reason = NULL,
             updated_at = NOW()
         WHERE id = $1
           AND workspace_id = $2
           AND revision = $3`,
        [input.documentId, input.workspaceId, input.revision],
      );

      return true;
    });
  }

  async listForDocumentRevision(input: {
    documentId: string;
    workspaceId: string;
  }): Promise<PublishedChunkRecord[]> {
    const rows = await this.database.query<{
      chunk_index: number;
      content: string;
      start_offset: number;
      end_offset: number;
      metadata: Record<string, unknown> | null;
    }>(
      `SELECT chunk_index,
              content,
              start_offset,
              end_offset,
              metadata
       FROM chunks
       WHERE document_id = $1 AND workspace_id = $2
       ORDER BY chunk_index ASC`,
      [input.documentId, input.workspaceId],
    );

    return rows.map((row) => ({
      chunkIndex: Number(row.chunk_index),
      content: row.content,
      startOffset: Number(row.start_offset),
      endOffset: Number(row.end_offset),
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
    }));
  }

  async updateMetadataForDocumentRevision(input: {
    documentId: string;
    workspaceId: string;
    revision: number;
    patches: ChunkMetadataRevisionPatch[];
  }): Promise<boolean> {
    return this.database.withTransaction(async (client) => {
      const documentRows = await client.query<{ id: string }>(
        `SELECT id
         FROM documents
         WHERE id = $1
           AND workspace_id = $2
           AND revision = $3
         FOR UPDATE`,
        [input.documentId, input.workspaceId, input.revision],
      );

      if (documentRows.rows.length === 0) {
        return false;
      }

      // Patch each chunk's metadata by index. The stored date_from/date_to
      // columns recompute from metadata automatically.
      for (const patch of input.patches) {
        await client.query(
          `UPDATE chunks
           SET metadata = $4::jsonb
           WHERE document_id = $1
             AND workspace_id = $2
             AND chunk_index = $3`,
          [input.documentId, input.workspaceId, patch.chunkIndex, JSON.stringify(patch.metadata)],
        );
      }
      await appendVectorFilterUpdatesForDocumentTransaction(client, {
        workspaceId: input.workspaceId,
        documentId: input.documentId,
      });

      return true;
    });
  }

  async listSummariesForDocument(input: { documentId: string; workspaceId: string }): Promise<ChunkSummary[]> {
    const rows = await this.database.query<{
      id: string;
      chunk_index: number;
      content: string;
      start_offset: number;
      end_offset: number;
      content_length: number;
      date_from: string | null;
      date_to: string | null;
    }>(
      `SELECT id,
              chunk_index,
              LEFT(content, $3) AS content,
              start_offset,
              end_offset,
              LENGTH(content) AS content_length,
              date_from::text,
              date_to::text
       FROM chunks
       WHERE document_id = $1 AND workspace_id = $2
       ORDER BY chunk_index ASC`,
      [input.documentId, input.workspaceId, CHUNK_CONTENT_PREVIEW_MAX_CHARS],
    );

    return rows.map((row) => ({
      id: row.id,
      chunkIndex: Number(row.chunk_index),
      contentPreview: row.content,
      contentLength: Number(row.content_length),
      startOffset: Number(row.start_offset),
      endOffset: Number(row.end_offset),
      dateFrom: row.date_from,
      dateTo: row.date_to,
    }));
  }

  async listPageForDocument(input: {
    documentId: string;
    workspaceId: string;
    startChunkIndex: number;
    limit: number;
  }): Promise<{ chunks: ChunkDetail[]; totalChunks: number; nextChunkIndex: number | null } | null> {
    const [countRows, rows] = await Promise.all([
      this.database.query<{ document_id: string; total_count: string }>(
        `SELECT d.id AS document_id, COUNT(c.id)::text AS total_count
         FROM documents d
         LEFT JOIN chunks c ON c.document_id = d.id AND c.workspace_id = d.workspace_id
         WHERE d.id = $1 AND d.workspace_id = $2
         GROUP BY d.id`,
        [input.documentId, input.workspaceId],
      ),
      this.database.query<ChunkDetailRow>(
        `SELECT c.id,
                c.document_id,
                c.workspace_id,
                c.chunk_index,
                c.content,
                c.search_text,
                c.start_offset,
                c.end_offset,
                c.metadata,
                c.created_at,
                (SELECT ce.dimensions
                   FROM chunk_embeddings ce
                   JOIN workspace_embedding_profiles p
                     ON p.workspace_id = ce.workspace_id
                    AND p.active_embedding_space_id = ce.embedding_space_id
                  WHERE ce.workspace_id = c.workspace_id
                    AND ce.chunk_id = c.id
                    AND ce.document_revision = d.revision
                  LIMIT 1) AS embedding_dimensions,
                c.date_from,
                c.date_to
         FROM chunks c
         JOIN documents d
           ON d.workspace_id = c.workspace_id
          AND d.id = c.document_id
         WHERE c.document_id = $1
           AND c.workspace_id = $2
           AND c.chunk_index >= $3
         ORDER BY c.chunk_index ASC
         LIMIT $4`,
        [input.documentId, input.workspaceId, input.startChunkIndex, input.limit + 1],
      ),
    ]);
    if (!countRows[0]) return null;
    const pageRows = rows.slice(0, input.limit);

    return {
      chunks: pageRows.map(mapChunkDetail),
      totalChunks: Number(countRows[0]?.total_count ?? "0"),
      nextChunkIndex: rows.length > input.limit ? Number(rows[input.limit]!.chunk_index) : null,
    };
  }

  async findByIdForDocument(input: {
    chunkId: string;
    documentId: string;
    workspaceId: string;
  }): Promise<ChunkDetail | null> {
    const rows = await this.database.query<ChunkDetailRow>(
      // The reported width comes from the canonical row for the workspace's active
      // embedding space, because that is the vector semantic search actually compares
      // against. Chunks are only inspectable as embedded after their canonical vector
      // projection has been written.
      `SELECT c.id,
              c.document_id,
              c.workspace_id,
              c.chunk_index,
              c.content,
              c.search_text,
              c.start_offset,
              c.end_offset,
              c.metadata,
              c.created_at,
              (SELECT ce.dimensions
                 FROM chunk_embeddings ce
                 JOIN workspace_embedding_profiles p
                   ON p.workspace_id = ce.workspace_id
                  AND p.active_embedding_space_id = ce.embedding_space_id
                WHERE ce.workspace_id = c.workspace_id
                  AND ce.chunk_id = c.id
                  AND ce.document_revision = d.revision
                LIMIT 1) AS embedding_dimensions,
              c.date_from,
              c.date_to
       FROM chunks c
       JOIN documents d
         ON d.workspace_id = c.workspace_id
        AND d.id = c.document_id
       WHERE c.id = $1 AND c.document_id = $2 AND c.workspace_id = $3`,
      [input.chunkId, input.documentId, input.workspaceId],
    );

    const row = rows[0];
    if (!row) {
      return null;
    }

    return mapChunkDetail(row);
  }
}

const lookupWorkspaceIdForDocument = async (client: QueryClient, documentId: string): Promise<string> => {
  const result = await client.query<{ workspace_id: string }>(
    `SELECT workspace_id
     FROM documents
     WHERE id = $1`,
    [documentId],
  );

  const workspaceId = result.rows[0]?.workspace_id;

  if (!workspaceId) {
    throw new Error(`Document ${documentId} not found while deleting chunks`);
  }

  return workspaceId;
};
