import type { Database } from "../../../shared/infra/database.js";
import type { RetrievedChunk } from "../domain/vectorSearch.js";
import type {
  TemporalCandidateRetrievalInput,
  TemporalCandidateRetrievalPort,
} from "../domain/temporal/temporalCandidateRetrieval.js";
import { compilePgChunkFilter } from "./pgChunkFilter.js";

interface TemporalCandidateRow {
  chunk_id: string;
  document_id: string;
  title: string;
  content: string;
  search_text: string | null;
  chunk_index: number;
  start_offset: number | null;
  end_offset: number | null;
  metadata: Record<string, unknown> | null;
}

export class PgTemporalCandidateRepository implements TemporalCandidateRetrievalPort {
  constructor(private readonly database: Database) {}

  async findUpcoming(input: TemporalCandidateRetrievalInput): Promise<RetrievedChunk[]> {
    const params: unknown[] = [
      input.workspaceId,
      input.today,
      input.topK,
    ];
    const chunkFilterClause = compilePgChunkFilter(input, params);

    const rows = await this.database.query<TemporalCandidateRow>(
      `SELECT c.id AS chunk_id,
              c.document_id,
              d.title,
              c.content,
              c.search_text,
              c.chunk_index,
              c.start_offset,
              c.end_offset,
              c.metadata
       FROM chunks c
       JOIN documents d ON d.id = c.document_id
       WHERE c.workspace_id = $1
         AND d.status = 'ready'
         AND (c.date_from >= $2::date OR c.date_to >= $2::date)
         ${chunkFilterClause}
       ORDER BY COALESCE(c.date_from, c.date_to) ASC,
                c.date_to ASC NULLS LAST,
                c.document_id ASC,
                c.chunk_index ASC,
                c.id ASC
       LIMIT $3`,
      params,
    );

    return rows.map((row) => ({
      chunkId: row.chunk_id,
      documentId: row.document_id,
      title: row.title,
      content: row.content,
      searchText: row.search_text,
      similarity: 0,
      chunkIndex: row.chunk_index,
      startOffset: row.start_offset,
      endOffset: row.end_offset,
      metadata: row.metadata ?? {},
    }));
  }
}
