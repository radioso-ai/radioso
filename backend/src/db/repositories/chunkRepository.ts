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
      chunk.accountId,
      chunk.chunkIndex,
      chunk.content,
      chunk.searchText ?? chunk.content,
      JSON.stringify(chunk.structuredAttributes ?? {}),
      `[${chunk.embedding.join(",")}]`,
      chunk.startOffset,
      chunk.endOffset,
    );

    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}::jsonb, $${offset + 8}::vector, $${offset + 9}, $${offset + 10})`;
  });

  await client.query(
    `INSERT INTO chunks (id, document_id, account_id, chunk_index, content, search_text, structured_attributes, embedding, start_offset, end_offset)
     VALUES ${placeholders.join(", ")}`,
    values,
  );
};

export class ChunkRepository implements ChunkRepositoryPort {
  constructor(private readonly database: Database) {}

  async replaceForDocument(documentId: string, chunks: ChunkRecord[]): Promise<void> {
    await this.database.withTransaction(async (client) => {
      await client.query("DELETE FROM chunks WHERE document_id = $1", [documentId]);
      await insertChunks(client, chunks);
    });
  }
}
