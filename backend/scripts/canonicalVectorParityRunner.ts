import { sql } from "kysely";

import { Database } from "../src/shared/infra/database.js";
import { PgVectorAdapter } from "../src/modules/retrieval/infra/pgVectorAdapter.js";
import { HnswIterativeScanRunner } from "../src/modules/retrieval/infra/hnswIterativeScan.js";
import { retrievableDocumentPredicateSql } from "../src/modules/retrieval/infra/documentRetrievalEligibility.js";
import type {
  VectorCandidate,
  VectorCandidateSearchInput,
} from "../src/modules/retrieval/domain/vectorAdapter.js";
import {
  compareRankings,
  summarizeParity,
  type ParitySummary,
  type RankingComparison,
} from "./canonicalVectorParity.js";

// Runs the two retrieval legs against Postgres so they can be compared. Kept apart
// from the CLI so the measurement is exercised by an integration test rather than only
// by an operator reading its output, and apart from canonicalVectorParity.ts so the
// comparison arithmetic stays pure.

// The retrieval graph asks for candidates without a score floor and filters later, so
// a floor here would hide disagreement in exactly the tail the merge was covering.
const PROBE_MINIMUM_SCORE = 0;

export interface ParityTarget {
  readonly workspaceId: string;
  readonly space: VectorCandidateSearchInput["space"];
  readonly model: string;
}

export interface ParityWorkspaceSelection {
  readonly targets: readonly ParityTarget[];
  /** Existing workspaces with no retrievable chunks; deleting a fallback loses nothing. */
  readonly zeroRiskWorkspaceIds: readonly string[];
  /** Requested ids that do not identify a workspace. */
  readonly unresolvedWorkspaceIds: readonly string[];
  /** Workspaces with retrievable chunks but no active cosine space to measure. */
  readonly missingActiveSpaceWorkspaceIds: readonly string[];
}

export interface ParityLegResult {
  readonly summary: ParitySummary;
  readonly comparisons: readonly RankingComparison[];
}

export interface WorkspaceParityMeasurement {
  readonly probes: number;
  /** Legacy leg as reference: what a turn returns today and canonical must still return. */
  readonly legacy: ParityLegResult;
  /** Exact scan as reference, measuring what the HNSW graph gives up. Null unless requested. */
  readonly indexRecall: ParityLegResult | null;
}

/**
 * Resolves every workspace the retirement decision must account for. The global path
 * begins with retrievable chunks, not embedding profiles, so an eligible workspace
 * cannot disappear merely because the metadata needed to measure it is absent.
 */
export const resolveParityWorkspaceSelection = async (
  database: Database,
  workspaceIds: readonly string[] = [],
): Promise<ParityWorkspaceSelection> => {
  const candidateWorkspaces = workspaceIds.length === 0
    ? sql`
      SELECT workspace_id FROM eligible_workspaces
      UNION
      SELECT workspace_id FROM workspace_embedding_profiles
    `
    : sql`
      SELECT DISTINCT requested.workspace_id
      FROM unnest(${workspaceIds}::uuid[]) AS requested(workspace_id)
    `;
  const rows = await sql<{
    workspace_id: string;
    workspace_exists: boolean;
    eligible_chunks: number;
    space_id: string | null;
    dimensions: number | null;
    model: string | null;
  }>`
    WITH eligible_workspaces AS (
      SELECT c.workspace_id, COUNT(*)::integer AS eligible_chunks
      FROM chunks c
      JOIN documents d
        ON d.workspace_id = c.workspace_id
       AND d.id = c.document_id
      WHERE ${sql.raw(retrievableDocumentPredicateSql("d"))}
        AND (${workspaceIds.length === 0}
          OR c.workspace_id = ANY(${workspaceIds}::uuid[]))
      GROUP BY c.workspace_id
    ),
    candidate_workspaces AS (
      ${candidateWorkspaces}
    )
    SELECT candidate.workspace_id,
           (w.id IS NOT NULL) AS workspace_exists,
           COALESCE(eligible.eligible_chunks, 0)::integer AS eligible_chunks,
           s.id AS space_id,
           s.dimensions,
           s.model
    FROM candidate_workspaces candidate
    LEFT JOIN workspaces w ON w.id = candidate.workspace_id
    LEFT JOIN eligible_workspaces eligible
      ON eligible.workspace_id = candidate.workspace_id
    LEFT JOIN workspace_embedding_profiles p
      ON p.workspace_id = candidate.workspace_id
    LEFT JOIN embedding_spaces s
      ON s.id = p.active_embedding_space_id
     AND s.status = 'active'
     AND s.distance_metric = 'cosine'
    ORDER BY candidate.workspace_id
  `.execute(database.kysely);

  const targets: ParityTarget[] = [];
  const zeroRiskWorkspaceIds: string[] = [];
  const unresolvedWorkspaceIds: string[] = [];
  const missingActiveSpaceWorkspaceIds: string[] = [];

  for (const row of rows.rows) {
    if (!row.workspace_exists) {
      unresolvedWorkspaceIds.push(row.workspace_id);
    } else if (Number(row.eligible_chunks) === 0) {
      zeroRiskWorkspaceIds.push(row.workspace_id);
    } else if (!row.space_id || row.dimensions === null || !row.model) {
      missingActiveSpaceWorkspaceIds.push(row.workspace_id);
    } else {
      targets.push({
        workspaceId: row.workspace_id,
        space: {
          id: row.space_id,
          dimensions: Number(row.dimensions),
          distanceMetric: "cosine",
        },
        model: row.model,
      });
    }
  }

  return {
    targets,
    zeroRiskWorkspaceIds,
    unresolvedWorkspaceIds,
    missingActiveSpaceWorkspaceIds,
  };
};

export const resolveParityTargets = async (
  database: Database,
  workspaceIds: readonly string[] = [],
): Promise<ParityTarget[]> =>
  (await resolveParityWorkspaceSelection(database, workspaceIds)).targets.slice();

/**
 * The workspace's own stored canonical vectors, used as probes.
 *
 * This needs no embedding provider, so the gate runs offline against a database clone,
 * and it is the standard protocol for measuring an approximate index against its own
 * contents. It is also the faithful shape: at runtime the query is embedded with the
 * workspace's active model, which is exactly what chunk_embeddings holds.
 */
export const sampleProbeVectors = async (
  database: Database,
  target: ParityTarget,
  count: number,
  seed: string,
): Promise<number[][]> => {
  // md5 over (chunk id, seed) is a deterministic shuffle: reproducible across runs and
  // across the two regional databases, and it leaves no session state behind the way
  // setseed() would.
  const rows = await sql<{ embedding: string }>`
    SELECT ce.embedding::text AS embedding
    FROM chunk_embeddings ce
    JOIN chunks c
      ON c.workspace_id = ce.workspace_id
     AND c.id = ce.chunk_id
    JOIN documents d
      ON d.workspace_id = c.workspace_id
     AND d.id = c.document_id
    WHERE ce.workspace_id = ${target.workspaceId}
      AND ce.embedding_space_id = ${target.space.id}
      AND ce.dimensions = ${target.space.dimensions}
      AND ce.document_revision = d.revision
      AND ${sql.raw(retrievableDocumentPredicateSql("d"))}
    ORDER BY md5(ce.chunk_id::text || ${seed})
    LIMIT ${count}
  `.execute(database.kysely);

  return rows.rows.map((row) => parseVector(row.embedding));
};

/**
 * Connection whose planner cannot reach an index, so the identical canonical query
 * returns exhaustive nearest neighbours. Running production's own SQL under a
 * different setting is what keeps the ground truth honest — a hand-written exact query
 * would drift from the adapter and quietly measure something else.
 *
 * Null when DATABASE_URL is not in URL form, since the setting rides on the
 * connection's `options` parameter.
 */
export const openExactSearchDatabase = (
  connectionString: string,
): Database | null => {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return null;
  }
  url.searchParams.set(
    "options",
    "-c enable_indexscan=off -c enable_bitmapscan=off",
  );
  return new Database(url.toString(), {
    applicationName: "radioso-canonical-parity-exact",
  });
};

export const measureWorkspaceParity = async (input: {
  target: ParityTarget;
  probeVectors: readonly number[][];
  topK: number;
  database: Database;
  exactDatabase?: Database | null;
}): Promise<WorkspaceParityMeasurement> => {
  const canonical = new PgVectorAdapter(input.database);
  const exact = input.exactDatabase
    ? new PgVectorAdapter(input.exactDatabase)
    : null;
  // The legacy leg runs under the same scan mode production gives it. Without
  // iterative scanning the HNSW index post-filters its candidates by workspace, so
  // the reference ranking comes back short and every chunk it failed to return is a
  // loss this gate never counts.
  const legacyScan = new HnswIterativeScanRunner(input.database);
  const legacyComparisons: RankingComparison[] = [];
  const exactComparisons: RankingComparison[] = [];
  for (const queryVector of input.probeVectors) {
    const searchInput = searchInputFor(input.target, [...queryVector], input.topK);
    const [canonicalHits, legacyHits] = await Promise.all([
      canonical.search.search(searchInput),
      searchLegacyChunkVectors(legacyScan, input.target, queryVector, input.topK),
    ]);
    legacyComparisons.push(compareRankings({
      reference: toRanked(legacyHits),
      candidate: toRanked(canonicalHits),
      topK: input.topK,
    }));

    if (exact) {
      // Production builds its HNSW graph incrementally as rows arrive, which yields a
      // worse graph than a bulk build. Measuring where the graph was built is the only
      // way to know what the accelerated path actually gives up.
      const exactHits = await exact.search.search(searchInput);
      exactComparisons.push(compareRankings({
        reference: toRanked(exactHits),
        candidate: toRanked(canonicalHits),
        topK: input.topK,
      }));
    }
  }

  return {
    probes: input.probeVectors.length,
    legacy: {
      summary: summarizeParity(legacyComparisons),
      comparisons: legacyComparisons,
    },
    indexRecall: exact
      ? { summary: summarizeParity(exactComparisons), comparisons: exactComparisons }
      : null,
  };
};

const searchInputFor = (
  target: ParityTarget,
  queryVector: number[],
  topK: number,
): VectorCandidateSearchInput => ({
  workspaceId: target.workspaceId,
  space: target.space,
  queryVector,
  topK,
  minimumScore: PROBE_MINIMUM_SCORE,
  // Both legs splice the same document-eligibility predicate, so an empty portable
  // filter compares the legs rather than the filter compiler.
  filter: {},
});

// This release gate deliberately reads the legacy projection directly rather than
// through the retrieval graph, so it keeps measuring the same rows after issue #1063
// step 3 unwires the legacy search leg. The column-drop migration (step 5) is written
// only once this gate's evidence passes, and it is what finally deletes this function.
const searchLegacyChunkVectors = async (
  scan: HnswIterativeScanRunner,
  target: ParityTarget,
  queryVector: readonly number[],
  topK: number,
): Promise<VectorCandidate[]> => {
  // The original 1536-dimensional projection used `embedding`; larger models used
  // `embedding_unbounded` with a compatibility fallback while the rollout was in
  // progress. This gate must reproduce that read shape or its reference ranking is
  // empty precisely for the workspaces whose migration risk is highest.
  const legacyEmbedding = legacyEmbeddingExpressionForDimensions(target.space.dimensions);
  const rows = await scan.run<{
    chunk_id: string;
    document_id: string;
    score: number;
  }>(
    `SELECT c.id AS chunk_id,
            c.document_id,
            GREATEST(-1.0, LEAST(1.0, 1.0 - (${legacyEmbedding} <=> $2::vector))) AS score
       FROM chunks c
       JOIN documents d
         ON d.workspace_id = c.workspace_id
        AND d.id = c.document_id
      WHERE c.workspace_id = $1
        AND ${legacyEmbedding} IS NOT NULL
        AND c.embedding_model = $3
        AND vector_dims(${legacyEmbedding}) = $4
        AND ${retrievableDocumentPredicateSql("d")}
      ORDER BY ${legacyEmbedding} <=> $2::vector
      LIMIT $5`,
    [target.workspaceId, `[${queryVector.join(",")}]`, target.model, target.space.dimensions, topK],
  );
  return rows.map((row) => ({
    chunkId: row.chunk_id,
    documentId: row.document_id,
    embeddingSpaceId: target.space.id,
    version: "0",
    score: Number(row.score),
  }));
};

export const legacyEmbeddingExpressionForDimensions = (
  dimensions: number,
): string => dimensions === 1536
  ? "c.embedding"
  : "COALESCE(c.embedding_unbounded, c.embedding)";

const parseVector = (serialized: string): number[] =>
  serialized.slice(1, -1).split(",").map(Number);

const toRanked = (candidates: readonly VectorCandidate[]) =>
  candidates.map((candidate) => ({
    chunkId: candidate.chunkId,
    score: candidate.score,
  }));
