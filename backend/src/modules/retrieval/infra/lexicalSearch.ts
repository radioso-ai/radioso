import { emptyStructuredAttributes } from "../domain/structuredAttributes.js";
import type { Database } from "../../../shared/infra/database.js";
import type { RetrievedChunk } from "./vectorSearch.js";

export interface LexicalSearchPort {
  search(input: {
    accountId: string;
    query: string;
    topK: number;
  }): Promise<RetrievedChunk[]>;
}

interface LexicalSearchRow {
  chunk_id: string;
  document_id: string;
  title: string;
  content: string;
  search_text: string | null;
  structured_attributes: RetrievedChunk["structuredAttributes"] | null;
  chunk_index: number;
  start_offset: number | null;
  end_offset: number | null;
  rank: number;
}

export class PgLexicalSearch implements LexicalSearchPort {
  constructor(private readonly database: Database) {}

  async search(input: {
    accountId: string;
    query: string;
    topK: number;
  }): Promise<RetrievedChunk[]> {
    const normalizedQuery = input.query.trim();
    if (!normalizedQuery) {
      return [];
    }

    const rows = await this.database.query<LexicalSearchRow>(
      `SELECT c.id AS chunk_id,
              c.document_id,
              d.title,
              c.content,
              c.search_text,
              c.structured_attributes,
              c.chunk_index,
              c.start_offset,
              c.end_offset,
              ts_rank_cd(
                to_tsvector('simple', coalesce(c.search_text, c.content, '')),
                plainto_tsquery('simple', $2)
              ) AS rank
       FROM chunks c
       JOIN documents d ON d.id = c.document_id
       WHERE c.account_id = $1
         AND plainto_tsquery('simple', $2) @@ to_tsvector('simple', coalesce(c.search_text, c.content, ''))
       ORDER BY rank DESC, c.chunk_index ASC
       LIMIT $3`,
      [input.accountId, normalizedQuery, input.topK],
    );

    return rows.map((row) => ({
      chunkId: row.chunk_id,
      documentId: row.document_id,
      title: row.title,
      content: row.content,
      searchText: row.search_text,
      structuredAttributes: row.structured_attributes ?? emptyStructuredAttributes(),
      similarity: Number(row.rank),
      chunkIndex: row.chunk_index,
      startOffset: row.start_offset,
      endOffset: row.end_offset,
    }));
  }
}
