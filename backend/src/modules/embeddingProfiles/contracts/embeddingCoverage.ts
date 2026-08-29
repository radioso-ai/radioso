/**
 * Read-only view of how far a workspace's chunks have been projected into
 * `chunk_embeddings`.
 *
 * Canonical coverage is otherwise invisible outside the database: reconciliation runs
 * on ingest, the operator backfill drains asynchronously, and nothing reports where a
 * workspace has got to. That matters when an embedding-model change re-indexes a
 * workspace and when an operator repairs a stalled backfill.
 */
export interface WorkspaceCanonicalEmbeddingCoverage {
  readonly workspaceId: string;
  /** Chunks the reconciler would serve: ready, retrieval-enabled, unexpired documents. */
  readonly eligibleChunks: number;
  readonly coveredChunks: number;
  readonly missingChunks: number;
  /**
   * Coverage enqueueing joins `workspace_embedding_profiles`, so a workspace without
   * one produces no jobs however often the backfill runs.
   */
  readonly hasEmbeddingProfile: boolean;
  readonly queuedJobs: number;
  /**
   * A failed `embedding_profile` job keeps the profile-job unique key, and enqueueing
   * suppresses inserts on conflict, so the gap it represents cannot be re-enqueued
   * until the failure is resolved. Non-zero here separates "still working" from "stuck".
   */
  readonly failedJobs: number;
}

export interface EmbeddingCoverageReadPort {
  getWorkspaceCanonicalEmbeddingCoverage(
    workspaceId: string,
  ): Promise<WorkspaceCanonicalEmbeddingCoverage>;
}
