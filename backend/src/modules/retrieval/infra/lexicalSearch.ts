import type { Database } from "../../../shared/infra/database.js";
import type { RetrievedChunk } from "./vectorSearch.js";
import { hasNonEmptyFilter } from "./vectorSearch.js";

export interface LexicalSearchPort {
  search(input: {
    workspaceId: string;
    query: string;
    topK: number;
    metadataFilter?: Record<string, unknown>;
  }): Promise<RetrievedChunk[]>;
}

interface LexicalSearchRow {
  chunk_id: string;
  document_id: string;
  title: string;
  content: string;
  search_text: string | null;
  chunk_index: number;
  start_offset: number | null;
  end_offset: number | null;
  metadata: Record<string, unknown> | null;
  rank: number;
}

export class PgLexicalSearch implements LexicalSearchPort {
  constructor(private readonly database: Database) {}

  async search(input: {
    workspaceId: string;
    query: string;
    topK: number;
    metadataFilter?: Record<string, unknown>;
  }): Promise<RetrievedChunk[]> {
    const normalizedQuery = input.query.trim();
    if (!normalizedQuery) {
      return [];
    }

    const params: unknown[] = [input.workspaceId, normalizedQuery, input.topK];
    const hasFilter = hasNonEmptyFilter(input.metadataFilter);
    const metadataClause = hasFilter ? `AND c.metadata @> $4::jsonb` : "";

    if (hasFilter) {
      params.push(JSON.stringify(input.metadataFilter));
    }

    const rows = await this.database.query<LexicalSearchRow>(
      `WITH search_query AS (
         SELECT websearch_to_tsquery('simple', $2) AS query
       )
       SELECT c.id AS chunk_id,
              c.document_id,
              d.title,
              c.content,
              c.search_text,
              c.chunk_index,
              c.start_offset,
              c.end_offset,
              c.metadata,
              ts_rank_cd(
                to_tsvector('simple', coalesce(c.search_text, c.content, '')),
                search_query.query
              ) AS rank
       FROM chunks c
       CROSS JOIN search_query
       JOIN documents d ON d.id = c.document_id
       WHERE c.workspace_id = $1
         AND d.status = 'ready'
         AND search_query.query @@ to_tsvector('simple', coalesce(c.search_text, c.content, ''))
         ${metadataClause}
       ORDER BY rank DESC, c.chunk_index ASC
       LIMIT $3`,
      params,
    );

    const maxRank = rows.reduce((highest, row) => Math.max(highest, Number(row.rank)), 0);

    return rows.map((row) => ({
      chunkId: row.chunk_id,
      documentId: row.document_id,
      title: row.title,
      content: row.content,
      searchText: row.search_text,
      similarity: normalizeLexicalRank(Number(row.rank), maxRank),
      chunkIndex: row.chunk_index,
      startOffset: row.start_offset,
      endOffset: row.end_offset,
      metadata: row.metadata ?? {},
    }));
  }
}

const normalizeLexicalRank = (rank: number, maxRank: number): number => {
  if (!Number.isFinite(rank) || rank <= 0 || maxRank <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(1, rank / maxRank));
};
