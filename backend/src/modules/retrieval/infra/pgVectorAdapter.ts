import type { Database } from "../../../shared/infra/database.js";
import {
  cosineSimilarity,
  compareVectorIndexVersions,
  supportsEmbeddingSpace,
  type VectorAdapter,
  type VectorCandidate,
  type VectorCandidateSearchInput,
  type VectorIndexCapabilities,
  type VectorIndexHealth,
  type VectorIndexMutation,
  type VectorIndexMutationResult,
  type VectorIndexWriteResult,
} from "../domain/vectorAdapter.js";
import { compilePgChunkFilter } from "./pgChunkFilter.js";
import { retrievableDocumentPredicateSql } from "./documentRetrievalEligibility.js";
import { HnswIterativeScanRunner } from "./hnswIterativeScan.js";
import {
  buildChunkEmbeddingDistanceExpression,
  buildChunkEmbeddingIndexDropSql,
  buildChunkEmbeddingIndexSql,
  parseChunkEmbeddingIndexWidth,
} from "./chunkEmbeddingVectorIndex.js";

const PGVECTOR_CAPABILITIES: VectorIndexCapabilities = {
  backend: "pgvector",
  dimensionRanges: [{ min: 1, max: 16_000 }],
  distanceMetrics: ["cosine"],
  filterOperations: [
    "source",
    "metadata_containment",
    "retrieval_eligibility",
    "expiry",
  ],
  maxBatchSize: 1_000,
  // Both modes are reachable and the width decides which. Up to pgvector's HNSW
  // ceiling a partial index answers the search approximately; above it, and before
  // a width's index exists, the same query is served by an exact scan. Declaring
  // only "exact" would misreport recall for every indexed width.
  searchModes: ["exact", "accelerated"],
  consistency: "transactional",
};

interface CandidateRow {
  chunk_id: string;
  document_id: string;
  embedding_space_id: string;
  canonical_version: string;
  score: number;
}

export class PgVectorAdapter
implements VectorAdapter {
  private readonly preparedSpaces = new Map<string, {
    dimensions: number;
    distanceMetric: "cosine";
  }>();
  private readonly acknowledgedVersions = new Map<string, string>();

  readonly capabilities = {
    getCapabilities: async (): Promise<VectorIndexCapabilities> => ({
      ...PGVECTOR_CAPABILITIES,
      dimensionRanges: PGVECTOR_CAPABILITIES.dimensionRanges.map((range) => ({
        ...range,
      })),
      distanceMetrics: [...PGVECTOR_CAPABILITIES.distanceMetrics],
      filterOperations: [...PGVECTOR_CAPABILITIES.filterOperations],
      searchModes: [...PGVECTOR_CAPABILITIES.searchModes],
    }),
  };

  readonly search = {
    search: async (
      input: VectorCandidateSearchInput,
    ): Promise<VectorCandidate[]> => this.searchExact(input),
  };

  readonly writer = {
    applyMutations: async (input: {
      workspaceId: string;
      space: VectorCandidateSearchInput["space"];
      mutations: VectorIndexMutation[];
    }): Promise<VectorIndexWriteResult> => {
      this.assertPrepared(input.space);
      if (input.mutations.length > PGVECTOR_CAPABILITIES.maxBatchSize) {
        throw new Error("vector_index_batch_too_large");
      }
      const mutations: VectorIndexMutationResult[] = [];
      for (const mutation of input.mutations) {
        mutations.push(await this.acknowledgeCanonicalMutation(
          input.workspaceId,
          input.space,
          mutation,
        ));
      }
      return { mutations };
    },
  };

  readonly admin = {
    prepareSpace: async (
      input: { space: VectorCandidateSearchInput["space"] },
    ): Promise<void> => {
      if (!supportsEmbeddingSpace(PGVECTOR_CAPABILITIES, input.space)) {
        throw new Error("unsupported_embedding_space");
      }
      const rows = await this.database.query<{
        dimensions: number;
        distance_metric: string;
        status: string;
      }>(
        `SELECT dimensions, distance_metric, status
         FROM embedding_spaces
         WHERE id = $1`,
        [input.space.id],
      );
      const stored = rows[0];
      if (!stored || stored.status !== "active") {
        throw new Error("vector_space_unavailable");
      }
      if (
        Number(stored.dimensions) !== input.space.dimensions
        || stored.distance_metric !== input.space.distanceMetric
      ) {
        throw new Error("embedding_space_definition_conflict");
      }
      // A width without its partial HNSW index falls back to a full scan of every
      // embedding in the workspace. Creating it here keeps index lifecycle with
      // space lifecycle, so a newly activated width is indexed without a migration.
      // IF NOT EXISTS makes this idempotent across restarts and replicas.
      // Widths past pgvector's HNSW ceiling have no index to build; the space stays
      // usable on exact search, which is why this does not reject the space.
      const indexSql = buildChunkEmbeddingIndexSql(input.space.dimensions);
      if (indexSql) {
        await this.withWidthLock(input.space.dimensions, async (client) => {
          await client.query(indexSql);
        });
      }
      this.preparedSpaces.set(input.space.id, {
        dimensions: input.space.dimensions,
        distanceMetric: input.space.distanceMetric,
      });
    },
    // Index lifecycle mirrors prepareSpace: a width's index exists only while rows of
    // that width do. Retiring an embedding space leaves its index matching nothing,
    // and Postgres still considers every index when planning, so a workspace that
    // changes model repeatedly would accumulate a permanent planning cost. Safe to
    // call at any time — a width whose rows return gets its index back from
    // prepareSpace before the next write lands.
    dropUnusedIndexes: async (): Promise<number> => {
      const indexes = await this.database.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
         WHERE tablename = 'chunk_embeddings' AND indexname LIKE 'chunk_embeddings_hnsw_%'`,
      );
      let dropped = 0;
      for (const { indexname } of indexes) {
        const width = parseChunkEmbeddingIndexWidth(indexname);
        if (width === null) {
          continue;
        }
        // Emptiness is re-checked under the same lock prepareSpace takes, so a space
        // being prepared for this width cannot have its index dropped from under it
        // between the check and the drop.
        const removed = await this.withWidthLock(width, async (client) => {
          const stillUsed = await client.query(
            "SELECT 1 FROM chunk_embeddings WHERE dimensions = $1 LIMIT 1",
            [width],
          );
          if ((stillUsed.rowCount ?? 0) > 0) {
            return false;
          }
          await client.query(buildChunkEmbeddingIndexDropSql(width));
          return true;
        });
        if (removed) {
          dropped += 1;
        }
      }
      return dropped;
    },
    resetSpace: async (
      input: { spaceId: string; workspaceId?: string },
    ): Promise<void> => {
      if (!this.preparedSpaces.has(input.spaceId)) {
        return;
      }
      // Canonical pgvector rows are source-of-truth, not a disposable
      // projection. Reset invalidates adapter lifecycle state only; a rebuild
      // coordinator streams/acknowledges canonical rows without deleting them.
      this.preparedSpaces.delete(input.spaceId);
    },
    getHealth: async (
      input: { spaceId?: string },
    ): Promise<VectorIndexHealth> => {
      try {
        await this.database.query("SELECT 1");
      } catch {
        return {
          backend: PGVECTOR_CAPABILITIES.backend,
          status: "unavailable",
          readiness: "unavailable",
          errorCode: "database_unavailable",
        };
      }
      const prepared = input.spaceId
        ? this.preparedSpaces.has(input.spaceId)
        : true;
      return {
        backend: PGVECTOR_CAPABILITIES.backend,
        status: prepared ? "available" : "unavailable",
        readiness: prepared ? "ready" : "unavailable",
      };
    },
  };

  private readonly iterativeScan: HnswIterativeScanRunner;

  constructor(private readonly database: Database) {
    this.iterativeScan = new HnswIterativeScanRunner(database);
  }

  /**
   * Serializes index lifecycle for one embedding width. Creation and the emptiness
   * check that precedes a drop contend on the same advisory key, so the two cannot
   * interleave and leave a populated width unindexed.
   */
  private async withWidthLock<T>(
    dimensions: number,
    callback: (client: {
      query(sql: string, params?: unknown[]): Promise<{ rowCount: number | null }>;
    }) => Promise<T>,
  ): Promise<T> {
    return this.database.withTransaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`chunk_embeddings_hnsw_width:${dimensions}`],
      );
      return callback(client);
    });
  }

  private async searchExact(
    input: VectorCandidateSearchInput,
  ): Promise<VectorCandidate[]> {
    assertSearchInput(input);

    // The width is emitted as a SQL literal rather than a bind parameter. The
    // per-width HNSW index is partial on `dimensions = <n>`; Postgres can prove that
    // predicate against a parameter while it still builds custom plans, but once a
    // prepared statement switches to a generic plan the value is unknown and the
    // proof fails, silently dropping the index. A literal keeps index matching
    // independent of plan caching. assertSearchInput has already validated the
    // space, and the expression builder re-checks the width is an integer.
    const width = input.space.dimensions;
    const { operand, queryCast } = buildChunkEmbeddingDistanceExpression(width, "$3");
    const params: unknown[] = [
      input.workspaceId,
      input.space.id,
      serializeVector(input.queryVector),
      input.minimumScore,
    ];
    const portableFilterClause = compilePgChunkFilter(
      {
        metadataFilter: input.filter.metadataContains,
        sourceFilter: input.filter.source,
      },
      params,
    );
    const retrievalEnabledClause =
      input.filter.retrievalEnabled === false ? "AND false" : "";
    const expiryClause = compileExpiryFilter(
      input.filter.notExpiredAt,
      params,
    );

    params.push(input.topK);
    const limitPlaceholder = `$${params.length}`;

    // Nearest-first with a LIMIT is the only shape an ANN index can answer. The
    // previous shape scored every eligible row before filtering, which the planner
    // could not serve from an index at all. Moving the score threshold after the
    // ordering preserves the ranking, because score decreases monotonically with
    // distance and thresholding only removes its tail. The CTE is deliberately not
    // MATERIALIZED — that barrier would block the index.
    //
    // Two things are not preserved, both deliberate. Where the index is used the
    // result is approximate rather than exhaustive. And widths in the halfvec band
    // compare at half precision, which can reorder near-identical neighbours; that
    // is the price of those widths being indexable at all. Ties at the LIMIT
    // boundary are therefore resolved arbitrarily — the outer sort orders only the
    // rows the inner query kept.
    const rows = await this.iterativeScan.run<CandidateRow>(
      `WITH nearest AS (
         SELECT
           ce.chunk_id,
           c.document_id,
           ce.embedding_space_id,
           ce.canonical_version,
           GREATEST(
             -1.0,
             LEAST(1.0, 1.0 - (ce.${operand} <=> ${queryCast}))
           ) AS score
         FROM chunk_embeddings ce
         JOIN chunks c
           ON c.workspace_id = ce.workspace_id
          AND c.id = ce.chunk_id
         JOIN documents d
           ON d.workspace_id = c.workspace_id
          AND d.id = c.document_id
         WHERE ce.workspace_id = $1
           AND ce.embedding_space_id = $2
           AND ce.dimensions = ${width}
           AND ce.document_revision = d.revision
           AND ${retrievableDocumentPredicateSql("d")}
           ${portableFilterClause}
           ${retrievalEnabledClause}
           ${expiryClause}
         ORDER BY ce.${operand} <=> ${queryCast}
         LIMIT ${limitPlaceholder}
       )
       SELECT
         chunk_id,
         document_id,
         embedding_space_id,
         canonical_version,
         score
       FROM nearest
       WHERE score >= $4
       ORDER BY score DESC, chunk_id ASC`,
      params,
    );

    return rows.map((row) => ({
      chunkId: row.chunk_id,
      documentId: row.document_id,
      embeddingSpaceId: row.embedding_space_id,
      version: String(row.canonical_version),
      score: Number(row.score),
    }));
  }

  private assertPrepared(space: VectorCandidateSearchInput["space"]): void {
    const prepared = this.preparedSpaces.get(space.id);
    if (!prepared) {
      throw new Error("vector_space_not_prepared");
    }
    if (
      prepared.dimensions !== space.dimensions
      || prepared.distanceMetric !== space.distanceMetric
    ) {
      throw new Error("embedding_space_definition_conflict");
    }
  }

  private async acknowledgeCanonicalMutation(
    workspaceId: string,
    space: VectorCandidateSearchInput["space"],
    mutation: VectorIndexMutation,
  ): Promise<VectorIndexMutationResult> {
    const chunkId = mutation.kind === "upsert"
      ? mutation.record.chunkId
      : mutation.chunkId;
    const requestedVersion = mutation.kind === "upsert"
      ? mutation.record.version
      : mutation.version;
    const acknowledgementKey = `${space.id}\u0000${workspaceId}\u0000${chunkId}`;
    const priorAcknowledgement = this.acknowledgedVersions.get(acknowledgementKey);
    if (priorAcknowledgement !== undefined) {
      const deliveryOrder = compareVectorIndexVersions(
        requestedVersion,
        priorAcknowledgement,
      );
      if (deliveryOrder <= 0) {
        return mutationResult(
          chunkId,
          requestedVersion,
          priorAcknowledgement,
          deliveryOrder === 0 ? "duplicate" : "ignored_stale",
        );
      }
    }
    if (mutation.kind === "upsert") {
      if (mutation.record.vector.length !== space.dimensions) {
        throw new Error("vector_dimension_mismatch");
      }
      cosineSimilarity(mutation.record.vector, mutation.record.vector);
    }
    const rows = await this.database.query<{ canonical_version: string }>(
      `SELECT canonical_version
       FROM chunk_embeddings
       WHERE workspace_id = $1
         AND embedding_space_id = $2
         AND chunk_id = $3`,
      [workspaceId, space.id, chunkId],
    );
    const canonicalVersion = rows[0]?.canonical_version;
    if (mutation.kind === "delete") {
      if (canonicalVersion === undefined) {
        this.acknowledgedVersions.set(acknowledgementKey, requestedVersion);
        return mutationResult(chunkId, requestedVersion, requestedVersion, "applied");
      }
      const ordering = compareVectorIndexVersions(
        requestedVersion,
        String(canonicalVersion),
      );
      if (ordering <= 0) {
        this.acknowledgedVersions.set(
          acknowledgementKey,
          String(canonicalVersion),
        );
        return mutationResult(
          chunkId,
          requestedVersion,
          String(canonicalVersion),
          ordering === 0 ? "duplicate" : "ignored_stale",
        );
      }
      throw new Error("canonical_delete_not_committed");
    }
    if (canonicalVersion === undefined) {
      throw new Error("canonical_vector_missing");
    }
    const ordering = compareVectorIndexVersions(
      requestedVersion,
      String(canonicalVersion),
    );
    if (ordering > 0) {
      throw new Error("canonical_projection_ahead_of_source");
    }
    this.acknowledgedVersions.set(
      acknowledgementKey,
      String(canonicalVersion),
    );
    return mutationResult(
      chunkId,
      requestedVersion,
      String(canonicalVersion),
      ordering === 0 ? "duplicate" : "ignored_stale",
    );
  }
}

const assertSearchInput = (input: VectorCandidateSearchInput): void => {
  if (!supportsEmbeddingSpace(PGVECTOR_CAPABILITIES, input.space)) {
    throw new Error("unsupported_embedding_space");
  }
  if (!Number.isInteger(input.topK) || input.topK <= 0) {
    throw new Error("invalid_vector_top_k");
  }
  if (
    !Number.isFinite(input.minimumScore)
    || input.minimumScore < -1
    || input.minimumScore > 1
  ) {
    throw new Error("invalid_vector_minimum_score");
  }
  if (input.queryVector.length !== input.space.dimensions) {
    throw new Error("vector_dimension_mismatch");
  }
  cosineSimilarity(input.queryVector, input.queryVector);
  if (
    input.filter.notExpiredAt !== undefined
    && !Number.isFinite(Date.parse(input.filter.notExpiredAt))
  ) {
    throw new Error("invalid_vector_index_timestamp");
  }
};

const compileExpiryFilter = (
  notExpiredAt: string | undefined,
  params: unknown[],
): string => {
  if (notExpiredAt === undefined) {
    return "";
  }
  params.push(notExpiredAt);
  return `AND (
    d.retrieval_expires_at IS NULL
    OR d.retrieval_expires_at > $${params.length}::timestamptz
  )`;
};

const serializeVector = (vector: readonly number[]): string =>
  `[${vector.join(",")}]`;

const mutationResult = (
  chunkId: string,
  requestedVersion: string,
  acknowledgedVersion: string,
  outcome: VectorIndexMutationResult["outcome"],
): VectorIndexMutationResult => ({
  chunkId,
  requestedVersion,
  acknowledgedVersion,
  outcome,
});
