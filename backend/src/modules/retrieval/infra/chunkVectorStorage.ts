import type { QueryResultRow } from "pg";

import type { ChunkRecord } from "../../documents/contracts/index.js";

const BOUNDED_VECTOR_DIMENSIONS = 1536;
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";

export interface ChunkVectorStorageClient {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

export interface ChunkVectorStoragePort {
  insertChunks(client: ChunkVectorStorageClient, chunks: ChunkRecord[]): Promise<void>;
}

export class PgVectorChunkStorage implements ChunkVectorStoragePort {
  async insertChunks(client: ChunkVectorStorageClient, chunks: ChunkRecord[]): Promise<void> {
    if (chunks.length === 0) {
      return;
    }

    const values: unknown[] = [];
    const placeholders = chunks.map((chunk, index) => {
      const offset = index * 12;
      const serializedEmbedding = serializeVector(chunk.embedding);
      const boundedEmbedding = chunk.embedding.length === BOUNDED_VECTOR_DIMENSIONS ? serializedEmbedding : null;
      const unboundedEmbedding = chunk.embedding.length === BOUNDED_VECTOR_DIMENSIONS ? null : serializedEmbedding;
      values.push(
        chunk.id,
        chunk.documentId,
        chunk.workspaceId,
        chunk.chunkIndex,
        chunk.content,
        chunk.searchText ?? chunk.content,
        boundedEmbedding,
        unboundedEmbedding,
        chunk.embeddingModel ?? DEFAULT_EMBEDDING_MODEL,
        chunk.startOffset,
        chunk.endOffset,
        JSON.stringify(chunk.metadata ?? {}),
      );

      return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}::vector, $${offset + 8}::vector, $${offset + 9}, $${offset + 10}, $${offset + 11}, $${offset + 12}::jsonb)`;
    });

    await client.query(
      `INSERT INTO chunks (id, document_id, workspace_id, chunk_index, content, search_text, embedding, embedding_unbounded, embedding_model, start_offset, end_offset, metadata)
       VALUES ${placeholders.join(", ")}`,
      values,
    );
  }
}

const serializeVector = (embedding: number[]): string => `[${embedding.join(",")}]`;
