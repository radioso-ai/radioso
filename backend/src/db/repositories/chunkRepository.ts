import type { PoolClient } from "pg";

import type { ChunkRecord, ChunkRepositoryPort } from "../../modules/documents/services/documentIngestionService.js";
import type { Database } from "../../shared/infra/database.js";

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
