import { sql, type ExpressionBuilder, type ExpressionWrapper, type SqlBool } from "kysely";

import type { Database } from "../../../shared/infra/database.js";
import type { DB } from "../../../shared/infra/kysely/schema.js";
import type { RetrievedChunk } from "../domain/vectorSearch.js";
import type {
  TemporalCandidateRetrievalInput,
  TemporalCandidateRetrievalPort,
} from "../domain/temporal/temporalCandidateRetrieval.js";
import { normalizeVectorMetadataFilter } from "../domain/vectorFilter.js";

type ChunkDocumentJoin = DB & { c: DB["chunks"]; d: DB["documents"] };

export class PgTemporalCandidateRepository implements TemporalCandidateRetrievalPort {
  constructor(private readonly database: Database) {}

  async findUpcoming(input: TemporalCandidateRetrievalInput): Promise<RetrievedChunk[]> {
    let query = this.database.kysely
      .selectFrom("chunks as c")
      .innerJoin("documents as d", "d.id", "c.document_id")
      .select([
        "c.id as chunk_id",
        "c.document_id",
        "d.title",
        "c.content",
        "c.search_text",
        "c.chunk_index",
        "c.start_offset",
        "c.end_offset",
        "c.metadata",
      ])
      .where("c.workspace_id", "=", input.workspaceId)
      .where("d.status", "=", "ready")
      .where((eb) =>
        eb.or([
          eb("c.date_from", ">=", sql<Date>`${input.today}::date`),
          eb("c.date_to", ">=", sql<Date>`${input.today}::date`),
        ]),
      )
      .orderBy(sql`COALESCE(c.date_from, c.date_to)`, "asc")
      .orderBy(sql`c.date_to ASC NULLS LAST`)
      .orderBy("c.document_id", "asc")
      .orderBy("c.chunk_index", "asc")
      .orderBy("c.id", "asc")
      .limit(input.topK);

    const sourceCondition = compileSourceCondition(input.sourceFilter);
    if (sourceCondition) {
      query = query.where(sourceCondition);
    }
    const metadataFilter = normalizeVectorMetadataFilter(input.metadataFilter);
    if (metadataFilter) {
      const metadataJson = JSON.stringify(metadataFilter);
      query = query.where(sql<boolean>`c.metadata @> ${metadataJson}::jsonb`);
    }

    const rows = await query.execute();

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
      metadata: (row.metadata as Record<string, unknown> | null) ?? {},
    }));
  }
}

const compileSourceCondition = (
  sourceFilter: TemporalCandidateRetrievalInput["sourceFilter"],
):
  | ((eb: ExpressionBuilder<ChunkDocumentJoin, "c" | "d">) => ExpressionWrapper<ChunkDocumentJoin, "c" | "d", SqlBool>)
  | null => {
  if (!sourceFilter?.constrained) {
    return null;
  }

  const { sourceIds, includeUnassignedDocuments } = sourceFilter;
  return (eb) => {
    const conditions: Array<ExpressionWrapper<ChunkDocumentJoin, "c" | "d", SqlBool>> = [];
    if (sourceIds.length > 0) {
      conditions.push(eb("d.source_id", "in", sourceIds));
    }
    if (includeUnassignedDocuments) {
      conditions.push(eb("d.source_id", "is", null));
    }
    // Constrained to zero sources and no unassigned documents matches nothing,
    // mirroring the `= ANY('{}')` semantics of the shared SQL filter compiler.
    return conditions.length > 0 ? eb.or(conditions) : eb.val<SqlBool>(false);
  };
};
