import type { PoolClient } from "pg";

import type {
  ChunkDetail,
  ChunkRecord,
  ChunkRepositoryPort,
  ChunkSummary,
} from "../../modules/documents/contracts/index.js";
import type { Database } from "../../shared/infra/database.js";

const CHUNK_CONTENT_PREVIEW_MAX_CHARS = 240;

export const insertChunks = async (client: PoolClient, chunks: ChunkRecord[]): Promise<void> => {
  if (chunks.length === 0) {
    return;
  }

  const values: unknown[] = [];
  const placeholders = chunks.map((chunk, index) => {
    const offset = index * 10;
    values.push(
      chunk.id,
      chunk.documentId,
      chunk.workspaceId,
      chunk.chunkIndex,
      chunk.content,
      chunk.searchText ?? chunk.content,
      `[${chunk.embedding.join(",")}]`,
      chunk.startOffset,
      chunk.endOffset,
      JSON.stringify(chunk.metadata ?? {}),
    );

    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}::vector, $${offset + 8}, $${offset + 9}, $${offset + 10}::jsonb)`;
  });

  await client.query(
    `INSERT INTO chunks (id, document_id, workspace_id, chunk_index, content, search_text, embedding, start_offset, end_offset, metadata)
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

      await client.query("DELETE FROM chunks WHERE document_id = $1 AND workspace_id = $2", [
        input.documentId,
        input.workspaceId,
      ]);
      await insertChunks(client, input.chunks);
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

  async listSummariesForDocument(input: { documentId: string; workspaceId: string }): Promise<ChunkSummary[]> {
    const rows = await this.database.query<{
      id: string;
      chunk_index: number;
      content: string;
      start_offset: number;
      end_offset: number;
      content_length: number;
    }>(
      `SELECT id,
              chunk_index,
              LEFT(content, $3) AS content,
              start_offset,
              end_offset,
              LENGTH(content) AS content_length
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
    }));
  }

  async findByIdForDocument(input: {
    chunkId: string;
    documentId: string;
    workspaceId: string;
  }): Promise<ChunkDetail | null> {
    const rows = await this.database.query<{
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
    }>(
      `SELECT id,
              document_id,
              workspace_id,
              chunk_index,
              content,
              search_text,
              start_offset,
              end_offset,
              metadata,
              created_at,
              vector_dims(embedding) AS embedding_dimensions
       FROM chunks
       WHERE id = $1 AND document_id = $2 AND workspace_id = $3`,
      [input.chunkId, input.documentId, input.workspaceId],
    );

    const row = rows[0];
    if (!row) {
      return null;
    }

    return {
      id: row.id,
      documentId: row.document_id,
      workspaceId: row.workspace_id,
      chunkIndex: Number(row.chunk_index),
      content: row.content,
      searchText: row.search_text,
      startOffset: Number(row.start_offset),
      endOffset: Number(row.end_offset),
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
      createdAt: row.created_at,
      embeddingDimensions: row.embedding_dimensions === null ? null : Number(row.embedding_dimensions),
    };
  }
}

const lookupWorkspaceIdForDocument = async (client: PoolClient, documentId: string): Promise<string> => {
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
