import { sql } from "kysely";

import type { Db } from "../../../shared/infra/kysely/types.js";
import type { JsonValue } from "../../../shared/infra/kysely/schema.js";
import type { RetrievedChunk } from "../domain/vectorSearch.js";
import type { RetrievalSourceFilter } from "../domain/retrievalSourceFilter.js";
import type { VectorCandidate } from "../domain/vectorAdapter.js";
import type { VectorMetadataFilter } from "../domain/vectorFilter.js";
import { hasVectorMetadataFilter } from "../domain/vectorFilter.js";
import { retrievableDocumentWhere } from "./documentRetrievalEligibility.js";

export interface ChunkCandidateHydratorPort {
  hydrate(input: {
    workspaceId: string;
    candidates: VectorCandidate[];
    metadataFilter?: VectorMetadataFilter;
    sourceFilter?: RetrievalSourceFilter;
  }): Promise<RetrievedChunk[]>;
}

export class PostgresChunkCandidateHydrator implements ChunkCandidateHydratorPort {
  constructor(private readonly db: Db) {}

  async hydrate(input: {
    workspaceId: string;
    candidates: VectorCandidate[];
    metadataFilter?: VectorMetadataFilter;
    sourceFilter?: RetrievalSourceFilter;
  }): Promise<RetrievedChunk[]> {
    const chunkIds = [...new Set(input.candidates.map((candidate) => candidate.chunkId))];
    if (chunkIds.length === 0) {
      return [];
    }

    let query = this.db
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
      .where(retrievableDocumentWhere("d"))
      .where(sql<boolean>`${sql.ref("c.id")} = any(${sql.val(chunkIds)}::uuid[])`)
      .orderBy(sql<number>`array_position(${sql.val(chunkIds)}::uuid[], ${sql.ref("c.id")})`);

    if (hasVectorMetadataFilter(input.metadataFilter)) {
      query = query.where(sql<boolean>`${sql.ref("c.metadata")} @> ${JSON.stringify(input.metadataFilter)}::jsonb`);
    }

    if (input.sourceFilter?.constrained) {
      const sourceFilter = input.sourceFilter;
      if (sourceFilter.sourceIds.length > 0 && sourceFilter.includeUnassignedDocuments) {
        query = query.where((eb) => eb.or([
          eb("d.source_id", "in", sourceFilter.sourceIds),
          eb("d.source_id", "is", null),
        ]));
      } else if (sourceFilter.sourceIds.length > 0) {
        query = query.where("d.source_id", "in", sourceFilter.sourceIds);
      } else if (sourceFilter.includeUnassignedDocuments) {
        query = query.where("d.source_id", "is", null);
      } else {
        query = query.where(sql<boolean>`false`);
      }
    }

    const rows = await query.execute();
    const rowByChunkId = new Map(rows.map((row) => [row.chunk_id, row]));

    return input.candidates.flatMap((candidate) => {
      const row = rowByChunkId.get(candidate.chunkId);
      if (!row) {
        return [];
      }

      return [{
        chunkId: row.chunk_id,
        documentId: row.document_id,
        title: row.title,
        content: row.content,
        searchText: row.search_text,
        similarity: candidate.score,
        chunkIndex: row.chunk_index,
        startOffset: row.start_offset,
        endOffset: row.end_offset,
        metadata: jsonRecord(row.metadata),
      }];
    });
  }
};

const jsonRecord = (value: JsonValue): Record<string, unknown> => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  return {};
};
