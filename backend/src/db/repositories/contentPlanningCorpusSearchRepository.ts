import { sql } from "kysely";

import type {
  ContentPlanningCorpusCandidate,
  ContentPlanningCorpusSearchPort,
} from "../../modules/contentPlanning/services/corpusEvidenceService.js";
import { retrievableDocumentWhere } from "../../shared/infra/kysely/documentRetrievalEligibility.js";
import {
  pgVectorCosineDistance,
  serializePgVector,
} from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";

const MAX_SEARCH_LIMIT = 100;

export class ContentPlanningCorpusSearchRepository implements ContentPlanningCorpusSearchPort {
  constructor(private readonly db: Db) {}

  async findRelatedDocuments(input: {
    workspaceId: string;
    embeddingSpaceId: string;
    centroid: readonly number[];
    limit: number;
  }): Promise<ContentPlanningCorpusCandidate[]> {
    assertSearchInput(input);
    const distance = pgVectorCosineDistance(sql.ref("ce.embedding"), input.centroid);
    const score = sql<number>`greatest(-1.0, least(1.0, 1.0 - ${distance}))`;
    const possibleRelevance = sql<number>`max(${score})`;

    const rows = await this.db
      .selectFrom("chunk_embeddings as ce")
      .innerJoin("chunks as c", (join) => join
        .onRef("c.workspace_id", "=", "ce.workspace_id")
        .onRef("c.id", "=", "ce.chunk_id"))
      .innerJoin("documents as d", (join) => join
        .onRef("d.workspace_id", "=", "c.workspace_id")
        .onRef("d.id", "=", "c.document_id"))
      .select([
        "d.id",
        "d.title",
        "d.created_at",
        "d.updated_at",
        possibleRelevance.as("possible_relevance"),
      ])
      .where("ce.workspace_id", "=", input.workspaceId)
      .where("ce.embedding_space_id", "=", input.embeddingSpaceId)
      .where("ce.dimensions", "=", input.centroid.length)
      .whereRef("ce.document_revision", "=", "d.revision")
      .where(retrievableDocumentWhere("d"))
      .groupBy(["d.id", "d.title", "d.created_at", "d.updated_at"])
      .orderBy(possibleRelevance, "desc")
      .orderBy("d.id", "asc")
      .limit(input.limit)
      .execute();

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      possibleRelevance: Number(row.possible_relevance),
      createdAt: toIsoInstant(row.created_at),
      updatedAt: toIsoInstant(row.updated_at),
    }));
  }
}

const assertSearchInput = (input: {
  workspaceId: string;
  embeddingSpaceId: string;
  centroid: readonly number[];
  limit: number;
}): void => {
  if (input.workspaceId.length === 0 || input.embeddingSpaceId.length === 0) {
    throw new Error("content_plan_corpus_scope_required");
  }
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_SEARCH_LIMIT) {
    throw new Error("content_plan_corpus_limit_invalid");
  }
  serializePgVector(input.centroid);
  if (input.centroid.every((value) => value === 0)) {
    throw new Error("content_plan_corpus_centroid_invalid");
  }
};

const toIsoInstant = (value: Date | string): string => {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("content_plan_corpus_document_timestamp_invalid");
  }
  return date.toISOString();
};
