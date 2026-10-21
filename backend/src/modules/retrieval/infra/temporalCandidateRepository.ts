import { sql, type ExpressionBuilder, type ExpressionWrapper, type QueryCreator, type SqlBool } from "kysely";

import type { Database } from "../../../shared/infra/database.js";
import { pgVectorCosineDistance, serializePgVector, toPgVector } from "../../../shared/infra/kysely/pgVectorSql.js";
import type { DB } from "../../../shared/infra/kysely/schema.js";
import type { RetrievedChunk } from "../domain/vectorSearch.js";
import type {
  TemporalCandidateRetrievalInput,
  TemporalCandidateRetrievalPort,
  TemporalLookupWindow,
  TemporalSimilarityQuery,
} from "../domain/temporal/temporalCandidateRetrieval.js";
import { normalizeVectorMetadataFilter } from "../domain/vectorFilter.js";
import { retrievableDocumentWhere } from "./documentRetrievalEligibility.js";

type ChunkDocumentJoin = DB & { c: DB["chunks"]; d: DB["documents"] };

export class PgTemporalCandidateRepository implements TemporalCandidateRetrievalPort {
  constructor(private readonly database: Database) {}

  async findInWindow(input: TemporalCandidateRetrievalInput): Promise<RetrievedChunk[]> {
    const window = input.window;
    return window.kind === "requested_range" && window.similarTo
      ? this.findInRangeBySimilarity(input, window.similarTo)
      : this.findInWindowByDate(input);
  }

  private async findInWindowByDate(input: TemporalCandidateRetrievalInput): Promise<RetrievedChunk[]> {
    let query = selectWindowChunks(this.database.kysely, input).select(CHUNK_COLUMNS);

    if (input.window.kind === "requested_range") {
      // Breadth first: every event's first chunk ranks ahead of any event's second chunk,
      // so a busy range fills the limit with distinct events before their detail chunks.
      query = query.orderBy(sql`row_number() OVER (PARTITION BY c.document_id ORDER BY c.chunk_index, c.id)`);
    }
    const rows = await query
      .orderBy(sql`COALESCE(c.date_from, c.date_to)`, "asc")
      .orderBy(sql`c.date_to ASC NULLS LAST`)
      .orderBy("c.document_id", "asc")
      .orderBy("c.chunk_index", "asc")
      .orderBy("c.id", "asc")
      .limit(input.topK)
      .execute();

    return rows.map((row) => toRetrievedChunk(row, 0));
  }

  // The range's chunks are collected first, as ids, dates, and revisions only, behind a
  // MATERIALIZED barrier, and only then scored against the question. Ordering by distance over
  // that set is an exact sort: no per-width HNSW index can serve it, so an index scan cannot
  // post-filter by date and run out of neighbours before it reaches the range. The distance is
  // full precision on the typeless column, and a chunk with no embedding in the space for its
  // document's current revision scores no distance and follows the scored chunks in date
  // order. Each document's chunks are tiered by their own closeness to the question, so an
  // event's most relevant chunk leads it. Content is read for the returned rows alone.
  private async findInRangeBySimilarity(
    input: TemporalCandidateRetrievalInput,
    similarTo: TemporalSimilarityQuery,
  ): Promise<RetrievedChunk[]> {
    assertSimilarityQuery(similarTo);
    const queryVector = toPgVector(serializePgVector(similarTo.queryVector));
    const rows = await this.database.kysely
      .with((cte) => cte("window_chunks").materialized(), (db) =>
        selectWindowChunks(db, input).select([
          "c.id as chunk_id",
          "c.document_id",
          "c.chunk_index",
          "c.date_from",
          "c.date_to",
          "d.revision as document_revision",
        ]))
      .with((cte) => cte("scored_chunks").materialized(), (db) =>
        db
          .selectFrom("window_chunks as w")
          .leftJoin("chunk_embeddings as ce", (join) =>
            join
              .onRef("ce.chunk_id", "=", "w.chunk_id")
              .onRef("ce.document_revision", "=", "w.document_revision")
              .on("ce.workspace_id", "=", input.workspaceId)
              .on("ce.embedding_space_id", "=", similarTo.space.id)
              .on("ce.dimensions", "=", similarTo.space.dimensions))
          .select([
            "w.chunk_id",
            "w.document_id",
            "w.chunk_index",
            "w.date_from",
            "w.date_to",
            sql<number | null>`${pgVectorCosineDistance(sql.ref("ce.embedding"), queryVector)}`.as("distance"),
          ]))
      .with("ranked_chunks", (db) =>
        db
          .selectFrom("scored_chunks")
          .selectAll()
          .select(sql<string>`row_number() OVER (
            PARTITION BY document_id ORDER BY distance ASC NULLS LAST, chunk_index, chunk_id
          )`.as("document_tier")))
      .with("top_chunks", (db) =>
        db
          .selectFrom("ranked_chunks")
          .select([
            "chunk_id",
            "document_id",
            "distance",
            sql<string>`row_number() OVER (
              ORDER BY document_tier, distance ASC NULLS LAST, COALESCE(date_from, date_to),
                date_to ASC NULLS LAST, document_id, chunk_index, chunk_id
            )`.as("position"),
          ])
          .orderBy("position", "asc")
          .limit(input.topK))
      .selectFrom("top_chunks as t")
      .innerJoin("chunks as c", "c.id", "t.chunk_id")
      .innerJoin("documents as d", "d.id", "t.document_id")
      .where("c.workspace_id", "=", input.workspaceId)
      .select([...CHUNK_COLUMNS, "t.distance"])
      .orderBy("t.position", "asc")
      .execute();

    return rows.map((row) =>
      toRetrievedChunk(row, row.distance === null ? 0 : Math.max(-1, Math.min(1, 1 - Number(row.distance)))));
  }
}

const CHUNK_COLUMNS = [
  "c.id as chunk_id",
  "c.document_id",
  "d.title",
  "c.content",
  "c.search_text",
  "c.chunk_index",
  "c.start_offset",
  "c.end_offset",
  "c.metadata",
] as const;

// Every chunk of a retrievable document in the workspace whose dates fall in the window,
// within the source and metadata scope.
const selectWindowChunks = (db: QueryCreator<DB>, input: TemporalCandidateRetrievalInput) => {
  let query = db
    .selectFrom("chunks as c")
    .innerJoin("documents as d", "d.id", "c.document_id")
    .where("c.workspace_id", "=", input.workspaceId)
    .where(retrievableDocumentWhere("d"))
    .where(compileWindowCondition(input.window));

  const sourceCondition = compileSourceCondition(input.sourceFilter);
  if (sourceCondition) {
    query = query.where(sourceCondition);
  }
  if (input.documentIds && input.documentIds.length > 0) {
    query = query.where("c.document_id", "in", [...input.documentIds]);
  }
  const metadataFilter = normalizeVectorMetadataFilter(input.metadataFilter);
  if (metadataFilter) {
    const metadataJson = JSON.stringify(metadataFilter);
    query = query.where(sql<boolean>`c.metadata @> ${metadataJson}::jsonb`);
  }
  return query;
};

const assertSimilarityQuery = (similarTo: TemporalSimilarityQuery): void => {
  if (similarTo.queryVector.length !== similarTo.space.dimensions) {
    throw new Error("vector_dimension_mismatch");
  }
  if (!similarTo.queryVector.every((value) => Number.isFinite(value))) {
    throw new Error("invalid_query_vector");
  }
};

const toRetrievedChunk = (
  row: {
    chunk_id: string;
    document_id: string;
    title: string;
    content: string;
    search_text: string | null;
    chunk_index: number;
    start_offset: number | null;
    end_offset: number | null;
    metadata: unknown;
  },
  similarity: number,
): RetrievedChunk => ({
  chunkId: row.chunk_id,
  documentId: row.document_id,
  title: row.title,
  content: row.content,
  searchText: row.search_text,
  similarity,
  chunkIndex: row.chunk_index,
  startOffset: row.start_offset,
  endOffset: row.end_offset,
  metadata: (row.metadata as Record<string, unknown> | null) ?? {},
});

const compileWindowCondition = (window: TemporalLookupWindow) =>
  (eb: ExpressionBuilder<ChunkDocumentJoin, "c" | "d">): ExpressionWrapper<ChunkDocumentJoin, "c" | "d", SqlBool> => {
    if (window.kind === "upcoming") {
      return eb.or([
        eb("c.date_from", ">=", sql<Date>`${window.today}::date`),
        eb("c.date_to", ">=", sql<Date>`${window.today}::date`),
      ]);
    }
    // GREATEST and LEAST skip NULLs, so a chunk with only one date is that single day,
    // and an inverted pair still spans its two dates. An undated chunk never matches.
    return eb.and([
      eb(eb.fn<Date>("greatest", ["c.date_from", "c.date_to"]), ">=", sql<Date>`${window.range.dateFrom}::date`),
      eb(eb.fn<Date>("least", ["c.date_from", "c.date_to"]), "<=", sql<Date>`${window.range.dateTo}::date`),
    ]);
  };

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
