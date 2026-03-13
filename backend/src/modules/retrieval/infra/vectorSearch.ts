import type { Database } from "../../../shared/infra/database.js";

export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  title: string;
  content: string;
  similarity: number;
}

export interface VectorSearchPort {
  search(input: {
    accountId: string;
    queryEmbedding: number[];
    topK: number;
    similarityThreshold: number;
  }): Promise<RetrievedChunk[]>;
}

interface VectorSearchRow {
  chunk_id: string;
  document_id: string;
  title: string;
  content: string;
  similarity: number;
}

export class PgVectorSearch implements VectorSearchPort {
  constructor(private readonly database: Database) {}

  async search(input: {
    accountId: string;
    queryEmbedding: number[];
    topK: number;
    similarityThreshold: number;
  }): Promise<RetrievedChunk[]> {
    const rows = await this.database.query<VectorSearchRow>(
      `SELECT c.id AS chunk_id,
              c.document_id,
              d.title,
              c.content,
              1 - (c.embedding <=> $2::vector) AS similarity
       FROM chunks c
       JOIN documents d ON d.id = c.document_id
       WHERE c.account_id = $1
         AND c.embedding IS NOT NULL
         AND 1 - (c.embedding <=> $2::vector) >= $3
       ORDER BY c.embedding <=> $2::vector ASC
       LIMIT $4`,
      [input.accountId, `[${input.queryEmbedding.join(",")}]`, input.similarityThreshold, input.topK],
    );

    return rows.map((row) => ({
      chunkId: row.chunk_id,
      documentId: row.document_id,
      title: row.title,
      content: row.content,
      similarity: Number(row.similarity),
    }));
  }
}
