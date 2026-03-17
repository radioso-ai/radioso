import type { StructuredAttributes } from "../domain/structuredAttributes.js";
import { emptyStructuredAttributes } from "../domain/structuredAttributes.js";
import type { Database } from "../../../shared/infra/database.js";

export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  title: string;
  content: string;
  searchText?: string | null;
  structuredAttributes?: StructuredAttributes;
  similarity: number;
  chunkIndex?: number;
  startOffset?: number | null;
  endOffset?: number | null;
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
  search_text: string | null;
  structured_attributes: StructuredAttributes | null;
  similarity: number;
  chunk_index: number;
  start_offset: number | null;
  end_offset: number | null;
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
              c.search_text,
              c.structured_attributes,
              c.chunk_index,
              c.start_offset,
              c.end_offset,
              1 - (c.embedding <=> $2::vector) AS similarity
       FROM chunks c
       JOIN documents d ON d.id = c.document_id
       WHERE c.account_id = $1
         AND d.status = 'ready'
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
      searchText: row.search_text,
      structuredAttributes: row.structured_attributes ?? emptyStructuredAttributes(),
      similarity: Number(row.similarity),
      chunkIndex: row.chunk_index,
      startOffset: row.start_offset,
      endOffset: row.end_offset,
    }));
  }
}
