import type { Database } from "../../../shared/infra/database.js";
import type { VectorIndexCandidate, VectorIndexSearchInput, VectorIndexPort } from "../domain/vectorIndex.js";
import type { RetrievedChunk, VectorSearchInput, VectorSearchPort } from "../domain/vectorSearch.js";
import { compilePgChunkFilter } from "./pgChunkFilter.js";

interface VectorSearchRow {
  chunk_id: string;
  document_id: string;
  title: string;
  content: string;
  search_text: string | null;
  similarity: number;
  chunk_index: number;
  start_offset: number | null;
  end_offset: number | null;
  metadata: Record<string, unknown> | null;
}

interface VectorIndexRow {
  chunk_id: string;
  document_id: string;
  score: number;
}

const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";

export class PgVectorIndex implements VectorIndexPort {
  constructor(private readonly database: Database) {}

  async search(input: VectorIndexSearchInput): Promise<VectorIndexCandidate[]> {
    const maxDistance = 1 - input.similarityThreshold;
    const queryEmbeddingDimensions = input.queryEmbeddingDimensions;
    const embeddingExpression = queryEmbeddingDimensions === 1536
      ? "c.embedding"
      : "COALESCE(c.embedding_unbounded, c.embedding)";
    const distanceExpression = queryEmbeddingDimensions === 1536
      ? `${embeddingExpression} <=> $2::vector(1536)`
      : `${embeddingExpression} <=> $2::vector`;
    const params: unknown[] = [
      input.workspaceId,
      `[${input.queryEmbedding.join(",")}]`,
      input.topK,
      maxDistance,
      input.embeddingModel,
      queryEmbeddingDimensions,
    ];
    const chunkFilterClause = compilePgChunkFilter({
      metadataFilter: input.filter.metadataContains,
      sourceFilter: input.filter.source,
    }, params);

    const sql = `WITH nearest_results AS MATERIALIZED (
      SELECT c.id AS chunk_id,
             c.document_id,
             ${distanceExpression} AS distance
      FROM chunks c
      JOIN documents d ON d.id = c.document_id
      WHERE c.workspace_id = $1
        AND d.status = 'ready'
        AND ${embeddingExpression} IS NOT NULL
        AND c.embedding_model = $5
        AND vector_dims(${embeddingExpression}) = $6
        ${chunkFilterClause}
      ORDER BY ${distanceExpression} ASC
      LIMIT $3
    )
    SELECT chunk_id,
           document_id,
           1 - distance AS score
    FROM nearest_results
    WHERE distance <= $4
    ORDER BY distance ASC`;

    const rows = await this.queryWithIterativeScan(sql, params);

    return rows.map((row) => ({
      chunkId: row.chunk_id,
      documentId: row.document_id,
      score: Number(row.score),
    }));
  }

  private async queryWithIterativeScan(sql: string, params: unknown[]): Promise<VectorIndexRow[]> {
    try {
      return await this.database.withTransaction(async (client) => {
        await client.query("SET LOCAL hnsw.iterative_scan = strict_order");
        const result = await client.query<VectorIndexRow>(sql, params);
        return result.rows;
      });
    } catch (error) {
      if (!isIterativeScanUnsupported(error)) {
        throw error;
      }

      return this.database.query<VectorIndexRow>(sql, params);
    }
  }
}

export class PgVectorSearch implements VectorSearchPort {
  constructor(private readonly database: Database) {}

  async search(input: VectorSearchInput): Promise<RetrievedChunk[]> {
    const maxDistance = 1 - input.similarityThreshold;
    const queryEmbeddingDimensions = input.queryEmbedding.length;
    const embeddingExpression = queryEmbeddingDimensions === 1536
      ? "c.embedding"
      : "COALESCE(c.embedding_unbounded, c.embedding)";
    const distanceExpression = queryEmbeddingDimensions === 1536
      ? `${embeddingExpression} <=> $2::vector(1536)`
      : `${embeddingExpression} <=> $2::vector`;
    const params: unknown[] = [
      input.workspaceId,
      `[${input.queryEmbedding.join(",")}]`,
      input.topK,
      maxDistance,
      input.embeddingModel ?? DEFAULT_EMBEDDING_MODEL,
      queryEmbeddingDimensions,
    ];
    const chunkFilterClause = compilePgChunkFilter(input, params);

    const sql = `WITH nearest_results AS MATERIALIZED (
      SELECT c.id AS chunk_id,
             c.document_id,
             d.title,
             c.content,
             c.search_text,
             c.chunk_index,
             c.start_offset,
             c.end_offset,
             c.metadata,
             ${distanceExpression} AS distance
      FROM chunks c
      JOIN documents d ON d.id = c.document_id
      WHERE c.workspace_id = $1
        AND d.status = 'ready'
        AND ${embeddingExpression} IS NOT NULL
        AND c.embedding_model = $5
        AND vector_dims(${embeddingExpression}) = $6
        ${chunkFilterClause}
      ORDER BY ${distanceExpression} ASC
      LIMIT $3
    )
    SELECT chunk_id,
           document_id,
           title,
           content,
           search_text,
           chunk_index,
           start_offset,
           end_offset,
           metadata,
           1 - distance AS similarity
    FROM nearest_results
    WHERE distance <= $4
    ORDER BY distance ASC`;

    const rows = await this.queryWithIterativeScan(sql, params);

    return rows.map((row) => ({
      chunkId: row.chunk_id,
      documentId: row.document_id,
      title: row.title,
      content: row.content,
      searchText: row.search_text,
      similarity: Number(row.similarity),
      chunkIndex: row.chunk_index,
      startOffset: row.start_offset,
      endOffset: row.end_offset,
      metadata: row.metadata ?? {},
    }));
  }

  private async queryWithIterativeScan(sql: string, params: unknown[]): Promise<VectorSearchRow[]> {
    try {
      return await this.database.withTransaction(async (client) => {
        await client.query("SET LOCAL hnsw.iterative_scan = strict_order");
        const result = await client.query<VectorSearchRow>(sql, params);
        return result.rows;
      });
    } catch (error) {
      if (!isIterativeScanUnsupported(error)) {
        throw error;
      }

      return this.database.query<VectorSearchRow>(sql, params);
    }
  }
}

const isIterativeScanUnsupported = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.message.includes("unrecognized configuration parameter \"hnsw.iterative_scan\"");
};
