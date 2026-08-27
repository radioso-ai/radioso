import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { QueryResultRow } from "pg";

import { currentTimestamp, toJsonb } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";
import type {
  DocumentProcessingJobEnrichmentOverride,
  DocumentProcessingJobOptions,
} from "../../modules/documents/contracts/documentContracts.js";
import type {
  WorkspaceCanonicalEmbeddingCoverage,
} from "../../modules/embeddingProfiles/contracts/embeddingCoverage.js";

export type DocumentProcessingJobStatus = "queued" | "processing" | "completed" | "failed" | "skipped";
// Vectorize jobs make a document queryable (chunk + embed + publish). Enrich jobs
// run the metadata-extraction LLM afterward at lower priority.
export type DocumentProcessingJobKind =
  | "vectorize"
  | "enrich"
  | "embedding_profile";
type RevisionProcessingJobKind = Exclude<
  DocumentProcessingJobKind,
  "embedding_profile"
>;
export interface DocumentProcessingJobRecord {
  id: string;
  documentId: string;
  workspaceId: string;
  documentRevision: number;
  kind: DocumentProcessingJobKind;
  status: DocumentProcessingJobStatus;
  attemptCount: number;
  lastError: string | null;
  availableAt: Date;
  claimedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  options?: DocumentProcessingJobOptions | null;
  embeddingSpaceId?: string | null;
  workspaceProfileGeneration?: string | null;
}

export interface DocumentProcessingQueueSnapshot {
  queuedJobCount: number;
  processingJobCount: number;
  oldestQueuedJobCreatedAt: Date | null;
}

export interface DocumentProcessingJobRepositoryPort {
  enqueue(input: { documentId: string; workspaceId: string; documentRevision: number; kind?: RevisionProcessingJobKind; options?: DocumentProcessingJobOptions | null }): Promise<DocumentProcessingJobRecord>;
  // Idempotently create the follow-up enrich job for a revision. Safe to call on
  // a vectorize retry: if the (document_id, document_revision, kind='enrich') row
  // already exists it is returned rather than inserted, so a re-run never fails on
  // the unique constraint.
  ensureEnrichJob(input: { documentId: string; workspaceId: string; documentRevision: number; options?: DocumentProcessingJobOptions | null }): Promise<DocumentProcessingJobRecord>;
  findById(jobId: string): Promise<DocumentProcessingJobRecord | null>;
  findByDocumentRevision(input: { documentId: string; workspaceId: string; documentRevision: number }): Promise<DocumentProcessingJobRecord | null>;
  claimNext(now?: Date): Promise<DocumentProcessingJobRecord | null>;
  claimById(jobId: string, now?: Date): Promise<DocumentProcessingJobRecord | null>;
  backfillMissingQueuedJobs(limit?: number): Promise<number>;
  ensureEmbeddingProfileJobsForTransition(input: {
    workspaceId: string;
    targetEmbeddingSpaceId: string;
    generation: string;
  }): Promise<number>;
  cancelEmbeddingProfileJobsForTransition(input: {
    workspaceId: string;
    targetEmbeddingSpaceId: string;
    generation: string;
  }): Promise<number>;
  listWorkspaceCanonicalEmbeddingGaps(): Promise<
    Array<{
      workspaceId: string;
      missingChunks: number;
      hasEmbeddingProfile: boolean;
      failedJobs: number;
    }>
  >;
  getWorkspaceCanonicalEmbeddingCoverage(
    workspaceId: string,
  ): Promise<WorkspaceCanonicalEmbeddingCoverage>;
  reconcileEmbeddingProfileJobsForWorkspace(input: {
    workspaceId: string;
  }): Promise<{ enqueued: number; skipped: number }>;
  listQueuedEmbeddingProfileJobsForWorkspace(input: {
    workspaceId: string;
    embeddingSpaceId?: string;
    generation?: string;
    limit?: number;
  }): Promise<DocumentProcessingJobRecord[]>;
  listProcessingJobs(): Promise<DocumentProcessingJobRecord[]>;
  getQueueSnapshot(now?: Date): Promise<DocumentProcessingQueueSnapshot>;
  markCompleted(jobId: string): Promise<void>;
  markSkipped(jobId: string, reason: string): Promise<void>;
  markFailed(jobId: string, errorMessage: string): Promise<void>;
  markFailedIfDocumentMatches(input: {
    jobId: string;
    documentId: string;
    workspaceId: string;
    revision: number;
    errorMessage: string;
  }): Promise<boolean>;
  reschedule(jobId: string, nextAttemptAt: Date, errorMessage: string): Promise<void>;
  releaseTimedOutClaim(jobId: string, claimedAtOrBefore: Date, errorMessage: string): Promise<boolean>;
}

// The canonical-coverage rule, defined once for every read of it.
//
// It mirrors reconcileEmbeddingProfileJobsForWorkspace's notion of coverage, or a
// report disagrees with the work it describes. A canonical row only counts when it
// belongs to a target space — active or pending — at the document's current revision,
// so rows left behind by an earlier space or an older revision are gaps rather than
// coverage. Document eligibility is applied for the same reason: the reconciler never
// enqueues documents it would not serve.
//
// Both fragments are referenced once per query, so Postgres inlines the CTEs and a
// per-workspace filter still reaches the underlying indexes.

const embeddingTargetSpacesSql = sql`
  SELECT p.workspace_id, spaces.embedding_space_id
  FROM workspace_embedding_profiles p
  CROSS JOIN LATERAL (
    SELECT DISTINCT embedding_space_id
    FROM (VALUES
      (p.active_embedding_space_id),
      (p.pending_embedding_space_id)
    ) AS candidates(embedding_space_id)
    WHERE embedding_space_id IS NOT NULL
  ) spaces
`;

// Retrieval binds to the active space. Pending-space rows are intentionally part of
// backfill scheduling above, but cannot make the active retrieval path searchable.
//
// So the two readers below deliberately disagree during a model transition:
// listWorkspaceCanonicalEmbeddingGaps counts a pending-space gap as work to schedule,
// while getWorkspaceCanonicalEmbeddingCoverage reports the workspace as covered
// because search already answers from the active space. An operator therefore sees
// complete coverage while the backfill script still exits non-zero, which is the
// intended reading of two different questions and not drift. Changing one to match
// the other would either hide unscheduled work or report an already-searchable
// workspace as broken.
const activeEmbeddingTargetSpaceSql = sql`
  SELECT workspace_id, active_embedding_space_id AS embedding_space_id
  FROM workspace_embedding_profiles
`;

const retrievableChunksSql = sql`
  SELECT c.workspace_id, c.id AS chunk_id, d.revision
  FROM chunks c
  JOIN documents d
    ON d.workspace_id = c.workspace_id
   AND d.id = c.document_id
  WHERE d.status = 'ready'
    AND d.retrieval_enabled = TRUE
    AND (d.retrieval_expires_at IS NULL OR d.retrieval_expires_at > NOW())
`;

// Correlated against the `eligible_chunks ec` / `targets t` aliases above.
//
// The space match is required, never optional. `targets` is LEFT JOINed, so a workspace
// with no embedding profile yields a NULL `t.embedding_space_id`, and accepting that as
// a wildcard let any leftover row — from a space the workspace never targeted — count as
// coverage. Such a workspace has nothing for retrieval to search and nothing the backfill
// can enqueue, yet it reported zero missing chunks: the dashboard showed "all chunks
// indexed" and the workspace dropped out of the gap list the backfill reads, so the script
// exited claiming there was no work. A NULL target now fails the comparison, which counts
// every eligible chunk as missing and leaves `hasEmbeddingProfile` to say why.
const canonicalRowExistsSql = sql`EXISTS (
  SELECT 1
  FROM chunk_embeddings ce
  WHERE ce.workspace_id = ec.workspace_id
    AND ce.chunk_id = ec.chunk_id
    AND ce.document_revision = ec.revision
    AND ce.embedding_space_id = t.embedding_space_id
)`;

// The per-workspace read references this CTE twice, so PostgreSQL materializes it.
// Put its tenant scope inside this shared definition rather than relying on either
// consumer predicate to push through the materialization boundary.
// `targetSpaces` follows whatever the caller counts as a gap. A response that pairs an
// active-space chunk count with an active-and-pending job count cannot be acted on:
// "nothing missing, one job failed" names work that its own numbers say does not exist,
// and a reader that treats a zero gap as done never reaches the failure.
const currentEmbeddingProfileGapJobsSql = (options: {
  workspaceId?: string;
  targetSpaces: "active" | "active_and_pending";
}) => {
  const workspaceScope = options.workspaceId === undefined
    ? sql``
    : sql`AND j.workspace_id = ${options.workspaceId}`;
  const spaceScope = options.targetSpaces === "active"
    ? sql`AND j.embedding_space_id = p.active_embedding_space_id`
    : sql`AND j.embedding_space_id IN (
       p.active_embedding_space_id,
       p.pending_embedding_space_id
     )`;

  return sql`
    SELECT j.workspace_id, j.status
    FROM document_processing_jobs j
    JOIN documents d
      ON d.workspace_id = j.workspace_id
     AND d.id = j.document_id
     AND d.revision = j.document_revision
    JOIN workspace_embedding_profiles p
      ON p.workspace_id = j.workspace_id
     AND p.generation = j.workspace_profile_generation
     ${spaceScope}
    WHERE j.kind = 'embedding_profile'
      ${workspaceScope}
      AND j.status IN ('queued', 'processing', 'failed')
      AND d.status = 'ready'
      AND d.retrieval_enabled = TRUE
      AND (d.retrieval_expires_at IS NULL OR d.retrieval_expires_at > NOW())
      AND EXISTS (
        SELECT 1
        FROM chunks c
        WHERE c.workspace_id = d.workspace_id
          AND c.document_id = d.id
          AND NOT EXISTS (
            SELECT 1
            FROM chunk_embeddings ce
            WHERE ce.workspace_id = c.workspace_id
              AND ce.chunk_id = c.id
              AND ce.embedding_space_id = j.embedding_space_id
              AND ce.document_revision = d.revision
          )
      )
  `;
};

export interface EmbeddingProfileJobTransactionClient {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
}

/**
 * Called inside canonical chunk publication. The profile row is locked so a
 * concurrent transition cannot publish a generation without its durable jobs.
 */
export const insertEmbeddingProfileJobsForDocumentRevision = async (
  client: EmbeddingProfileJobTransactionClient,
  input: {
    workspaceId: string;
    documentId: string;
    documentRevision: number;
    activeEmbeddingSpaceId: string;
  },
): Promise<number> => {
  const profile = await client.query<{
    active_embedding_space_id: string;
  }>(
    `SELECT active_embedding_space_id
     FROM workspace_embedding_profiles
     WHERE workspace_id = $1
     FOR UPDATE`,
    [input.workspaceId],
  );
  if (profile.rows.length === 0) {
    return 0;
  }
  if (profile.rows[0]!.active_embedding_space_id !== input.activeEmbeddingSpaceId) {
    throw new Error("Workspace embedding profile changed during canonical publication");
  }
  const result = await client.query(
    `INSERT INTO document_processing_jobs
       (id, document_id, workspace_id, document_revision, kind, status,
        embedding_space_id, workspace_profile_generation)
     SELECT gen_random_uuid(), $2, $1, $3, 'embedding_profile', 'queued',
            spaces.embedding_space_id, profile.generation
     FROM workspace_embedding_profiles profile
     CROSS JOIN LATERAL (
       SELECT DISTINCT embedding_space_id
       FROM (VALUES
         (profile.active_embedding_space_id),
         (profile.pending_embedding_space_id)
       ) AS candidates(embedding_space_id)
       WHERE embedding_space_id IS NOT NULL
     ) spaces
     WHERE profile.workspace_id = $1
     ON CONFLICT (
       document_id, document_revision, kind, embedding_space_id,
       workspace_profile_generation
     )
       WHERE kind = 'embedding_profile'
     DO NOTHING`,
    [input.workspaceId, input.documentId, input.documentRevision],
  );
  return result.rowCount ?? 0;
};

interface DocumentProcessingJobRow {
  id: string;
  document_id: string;
  workspace_id: string;
  document_revision: number;
  kind: DocumentProcessingJobKind;
  status: DocumentProcessingJobStatus;
  attempt_count: number;
  last_error: string | null;
  available_at: Date;
  claimed_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  options: Record<string, unknown> | null;
  embedding_space_id: string | null;
  workspace_profile_generation: string | null;
}

const mapJob = (row: DocumentProcessingJobRow): DocumentProcessingJobRecord => ({
  id: row.id,
  documentId: row.document_id,
  workspaceId: row.workspace_id,
  documentRevision: row.document_revision,
  kind: normalizeJobKind(row.kind),
  status: row.status,
  attemptCount: row.attempt_count,
  lastError: row.last_error,
  availableAt: new Date(row.available_at),
  claimedAt: row.claimed_at ? new Date(row.claimed_at) : null,
  completedAt: row.completed_at ? new Date(row.completed_at) : null,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
  options: mapJobOptions(row.options),
  embeddingSpaceId: row.embedding_space_id,
  workspaceProfileGeneration: row.workspace_profile_generation === null
    ? null
    : String(row.workspace_profile_generation),
});

const normalizeJobKind = (value: unknown): DocumentProcessingJobKind =>
  value === "enrich" || value === "embedding_profile" ? value : "vectorize";

const mapJobOptions = (value: Record<string, unknown> | null): DocumentProcessingJobOptions | null => {
  if (!value || typeof value !== "object") {
    return null;
  }
  const override = value.documentEnrichmentOverride;
  if (override !== "on" && override !== "off") {
    return null;
  }
  return { documentEnrichmentOverride: override };
};

const documentProcessingJobColumns = [
  "id",
  "document_id",
  "workspace_id",
  "document_revision",
  "kind",
  "status",
  "attempt_count",
  "last_error",
  "available_at",
  "claimed_at",
  "completed_at",
  "created_at",
  "updated_at",
  "options",
  "embedding_space_id",
  "workspace_profile_generation",
] as const;

export class DocumentProcessingJobRepository implements DocumentProcessingJobRepositoryPort {
  constructor(private readonly db: Db) {}

  async enqueue(input: { documentId: string; workspaceId: string; documentRevision: number; kind?: RevisionProcessingJobKind; options?: DocumentProcessingJobOptions | null }): Promise<DocumentProcessingJobRecord> {
    const row = await this.db
      .insertInto("document_processing_jobs")
      .values({
        id: randomUUID(),
        document_id: input.documentId,
        workspace_id: input.workspaceId,
        document_revision: input.documentRevision,
        kind: input.kind ?? "vectorize",
        status: "queued",
        options: input.options ? toJsonb(input.options) : null,
      })
      .returning(documentProcessingJobColumns)
      .executeTakeFirstOrThrow();

    return mapJob(row as DocumentProcessingJobRow);
  }

  async ensureEnrichJob(input: { documentId: string; workspaceId: string; documentRevision: number; options?: DocumentProcessingJobOptions | null }): Promise<DocumentProcessingJobRecord> {
    const inserted = await this.db
      .insertInto("document_processing_jobs")
      .values({
        id: randomUUID(),
        document_id: input.documentId,
        workspace_id: input.workspaceId,
        document_revision: input.documentRevision,
        kind: "enrich",
        status: "queued",
        options: input.options ? toJsonb(input.options) : null,
      })
      .onConflict((oc) =>
        oc
          .columns(["document_id", "document_revision", "kind"])
          .where("kind", "!=", sql.lit("embedding_profile"))
          .doNothing(),
      )
      .returning(documentProcessingJobColumns)
      .executeTakeFirst();

    if (inserted) {
      return mapJob(inserted as DocumentProcessingJobRow);
    }

    const existing = await this.db
      .selectFrom("document_processing_jobs")
      .select(documentProcessingJobColumns)
      .where("document_id", "=", input.documentId)
      .where("document_revision", "=", input.documentRevision)
      .where("kind", "=", "enrich")
      .executeTakeFirstOrThrow();

    return mapJob(existing as DocumentProcessingJobRow);
  }

  async findById(jobId: string): Promise<DocumentProcessingJobRecord | null> {
    const row = await this.db
      .selectFrom("document_processing_jobs")
      .select(documentProcessingJobColumns)
      .where("id", "=", jobId)
      .executeTakeFirst();

    return row ? mapJob(row as DocumentProcessingJobRow) : null;
  }

  async findByDocumentRevision(input: {
    documentId: string;
    workspaceId: string;
    documentRevision: number;
  }): Promise<DocumentProcessingJobRecord | null> {
    const row = await this.db
      .selectFrom("document_processing_jobs")
      .select(documentProcessingJobColumns)
      .where("document_id", "=", input.documentId)
      .where("workspace_id", "=", input.workspaceId)
      .where("document_revision", "=", input.documentRevision)
      // Callers dispatch the freshly-queued vectorize job; the follow-up enrich
      // job is enqueued and dispatched by the processing service itself.
      .where("kind", "=", "vectorize")
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirst();

    return row ? mapJob(row as DocumentProcessingJobRow) : null;
  }

  async claimNext(now: Date = new Date()): Promise<DocumentProcessingJobRecord | null> {
    return this.db.transaction().execute(async (trx) => {
      const nextJob = await trx
        .selectFrom("document_processing_jobs")
        .select("id")
        .where("status", "=", "queued")
        .where("available_at", "<=", now)
        // Preserve interactive ingestion priority while still draining profile
        // backfill ahead of optional metadata enrichment.
        .orderBy(sql<number>`CASE kind
          WHEN 'vectorize' THEN 0
          WHEN 'embedding_profile' THEN 1
          ELSE 2
        END`, "asc")
        .orderBy("created_at", "asc")
        .forUpdate()
        .skipLocked()
        .limit(1)
        .executeTakeFirst();

      if (!nextJob) {
        return null;
      }

      const row = await trx
        .updateTable("document_processing_jobs")
        .set((eb) => ({
          status: "processing",
          attempt_count: eb("attempt_count", "+", 1),
          claimed_at: now,
          updated_at: now,
        }))
        .where("id", "=", nextJob.id)
        .returning(documentProcessingJobColumns)
        .executeTakeFirst();

      return row ? mapJob(row as DocumentProcessingJobRow) : null;
    });
  }

  async claimById(jobId: string, now: Date = new Date()): Promise<DocumentProcessingJobRecord | null> {
    return this.db.transaction().execute(async (trx) => {
      const row = await trx
        .updateTable("document_processing_jobs")
        .set((eb) => ({
          status: "processing",
          attempt_count: eb("attempt_count", "+", 1),
          claimed_at: now,
          updated_at: now,
        }))
        .where("id", "=", jobId)
        .where("status", "=", "queued")
        .where("available_at", "<=", now)
        .returning(documentProcessingJobColumns)
        .executeTakeFirst();

      return row ? mapJob(row as DocumentProcessingJobRow) : null;
    });
  }

  async backfillMissingQueuedJobs(limit = 100): Promise<number> {
    return this.db.transaction().execute(async (trx) => {
      const missingRows = await trx
        .selectFrom("documents as d")
        .select(["d.id", "d.workspace_id", "d.revision"])
        .where("d.status", "=", "queued")
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom("document_processing_jobs as jobs")
                .select("jobs.id")
                .whereRef("jobs.document_id", "=", "d.id")
                .whereRef("jobs.document_revision", "=", "d.revision")
                // Only the vectorize phase makes a queued document ready; an
                // orphaned queued document missing its vectorize job must be
                // repaired even if a stale enrich job somehow exists.
                .where("jobs.kind", "=", "vectorize"),
            ),
          ),
        )
        .orderBy("d.updated_at", "asc")
        .orderBy("d.id", "asc")
        .limit(limit)
        .forUpdate("d")
        .skipLocked()
        .execute();

      for (const row of missingRows) {
        await trx
          .insertInto("document_processing_jobs")
          .values({
            id: randomUUID(),
            document_id: row.id,
            workspace_id: row.workspace_id,
            document_revision: row.revision,
            status: "queued",
          })
          .execute();
      }

      return missingRows.length;
    });
  }

  async ensureEmbeddingProfileJobsForTransition(input: {
    workspaceId: string;
    targetEmbeddingSpaceId: string;
    generation: string;
  }): Promise<number> {
    const result = await sql`
      INSERT INTO document_processing_jobs
        (id, document_id, workspace_id, document_revision, kind, status,
         embedding_space_id, workspace_profile_generation)
      SELECT gen_random_uuid(), d.id, d.workspace_id, d.revision,
             'embedding_profile', 'queued', ${input.targetEmbeddingSpaceId},
             ${input.generation}::bigint
      FROM documents d
      JOIN workspace_embedding_profiles p ON p.workspace_id = d.workspace_id
      WHERE d.workspace_id = ${input.workspaceId}
        AND d.status = 'ready'
        AND d.retrieval_enabled = TRUE
        AND (d.retrieval_expires_at IS NULL OR d.retrieval_expires_at > NOW())
        AND p.pending_embedding_space_id = ${input.targetEmbeddingSpaceId}
        AND p.generation = ${input.generation}::bigint
      ON CONFLICT (
        document_id, document_revision, kind, embedding_space_id,
        workspace_profile_generation
      )
        WHERE kind = 'embedding_profile'
      DO NOTHING
    `.execute(this.db);
    return Number(result.numAffectedRows ?? 0);
  }

  async cancelEmbeddingProfileJobsForTransition(input: {
    workspaceId: string;
    targetEmbeddingSpaceId: string;
    generation: string;
  }): Promise<number> {
    const result = await this.db
      .updateTable("document_processing_jobs")
      .set({
        status: "skipped",
        last_error: "profile_superseded",
        completed_at: currentTimestamp(),
        claimed_at: null,
        updated_at: currentTimestamp(),
      })
      .where("workspace_id", "=", input.workspaceId)
      .where("kind", "=", "embedding_profile")
      .where("embedding_space_id", "=", input.targetEmbeddingSpaceId)
      .where("workspace_profile_generation", "=", input.generation)
      .where("status", "in", ["queued", "processing", "failed"])
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  // Read-only view of the canonical projection backlog: retrievable chunks without
  // a chunk_embeddings row for a targeted space. Coverage reconciliation is enqueued
  // per workspace, so this reports where that work is still outstanding — chiefly
  // for operators running the one-time backfill after upgrading.
  async listWorkspaceCanonicalEmbeddingGaps(): Promise<
    Array<{
      workspaceId: string;
      missingChunks: number;
      hasEmbeddingProfile: boolean;
      failedJobs: number;
    }>
  > {
    // hasEmbeddingProfile decides whether the gap is actionable — enqueueing joins
    // workspace_embedding_profiles, so a workspace without one yields no jobs, and
    // reporting the flag keeps that from looking like a successful no-op run.
    // failedJobs matters because enqueueing suppresses inserts on the profile-job
    // unique key. A job that has exhausted its attempts keeps that key, so the gap
    // it represents can never be re-enqueued — the report would otherwise show work
    // that no number of re-runs will move.
    const result = await sql<{
      workspace_id: string;
      missing_chunks: string;
      has_embedding_profile: boolean;
      failed_jobs: string;
    }>`
      WITH targets AS (${embeddingTargetSpacesSql}),
      eligible_chunks AS (${retrievableChunksSql}),
      current_gap_jobs AS (${currentEmbeddingProfileGapJobsSql({ targetSpaces: "active_and_pending" })})
      SELECT ec.workspace_id,
             COUNT(DISTINCT ec.chunk_id) AS missing_chunks,
             BOOL_OR(t.workspace_id IS NOT NULL) AS has_embedding_profile,
             (SELECT COUNT(*)
                FROM current_gap_jobs j
               WHERE j.workspace_id = ec.workspace_id
                 AND j.status = 'failed') AS failed_jobs
      FROM eligible_chunks ec
      LEFT JOIN targets t ON t.workspace_id = ec.workspace_id
      WHERE NOT ${canonicalRowExistsSql}
      GROUP BY ec.workspace_id
      ORDER BY COUNT(DISTINCT ec.chunk_id) DESC
    `.execute(this.db);

    return result.rows.map((row) => ({
      workspaceId: row.workspace_id,
      missingChunks: Number(row.missing_chunks),
      hasEmbeddingProfile: row.has_embedding_profile,
      failedJobs: Number(row.failed_jobs),
    }));
  }

  // The same backlog for one workspace, with the denominator the gap list omits.
  // "4,329 outstanding" reads identically whether a workspace is nearly finished or
  // has not started, so progress needs both numbers; this is what the dashboard shows
  // while the backfill drains.
  async getWorkspaceCanonicalEmbeddingCoverage(
    workspaceId: string,
  ): Promise<WorkspaceCanonicalEmbeddingCoverage> {
    // Backfill schedules both active and pending spaces, but this status answers a
    // different question: whether the currently active retrieval path is covered.
    // A pending row cannot stand in for an active row, because runtime only searches
    // the active space. The job counts take the same scope as the chunk counts, so a
    // caller can read the whole response as one answer; a pending-space failure is the
    // gap report's to raise, and listWorkspaceCanonicalEmbeddingGaps still raises it.
    //
    // hasEmbeddingProfile is an independent EXISTS rather than an aggregate over the
    // join: a workspace with a profile and no chunks yet still has one, and the join
    // has no row to carry that.
    const row = await sql<{
      eligible_chunks: string;
      missing_chunks: string;
      has_embedding_profile: boolean;
      queued_jobs: string;
      failed_jobs: string;
    }>`
      WITH targets AS (${activeEmbeddingTargetSpaceSql}),
      eligible_chunks AS (${retrievableChunksSql}),
      current_gap_jobs AS (${currentEmbeddingProfileGapJobsSql({ workspaceId, targetSpaces: "active" })}),
      coverage AS (
        SELECT COUNT(DISTINCT ec.chunk_id) AS eligible_chunks,
               COUNT(DISTINCT ec.chunk_id)
                 FILTER (WHERE NOT ${canonicalRowExistsSql}) AS missing_chunks
        FROM eligible_chunks ec
        LEFT JOIN targets t ON t.workspace_id = ec.workspace_id
        WHERE ec.workspace_id = ${workspaceId}
      )
      SELECT coverage.eligible_chunks,
             coverage.missing_chunks,
             EXISTS (
               SELECT 1 FROM workspace_embedding_profiles p
               WHERE p.workspace_id = ${workspaceId}
             ) AS has_embedding_profile,
             (SELECT COUNT(*)
                FROM current_gap_jobs j
               WHERE j.workspace_id = ${workspaceId}
                 AND j.status IN ('queued', 'processing')) AS queued_jobs,
             (SELECT COUNT(*)
                FROM current_gap_jobs j
               WHERE j.workspace_id = ${workspaceId}
                 AND j.status = 'failed') AS failed_jobs
      FROM coverage
    `.execute(this.db);

    const coverage = row.rows[0];
    const eligibleChunks = Number(coverage?.eligible_chunks ?? 0);
    const missingChunks = Number(coverage?.missing_chunks ?? 0);
    return {
      workspaceId,
      eligibleChunks,
      coveredChunks: eligibleChunks - missingChunks,
      missingChunks,
      hasEmbeddingProfile: coverage?.has_embedding_profile ?? false,
      queuedJobs: Number(coverage?.queued_jobs ?? 0),
      failedJobs: Number(coverage?.failed_jobs ?? 0),
    };
  }

  async reconcileEmbeddingProfileJobsForWorkspace(input: {
    workspaceId: string;
  }): Promise<{ enqueued: number; skipped: number }> {
    return this.db.transaction().execute(async (trx) => {
      const skipped = await sql`
        UPDATE document_processing_jobs jobs
        SET status = 'skipped',
            last_error = 'profile_superseded',
            completed_at = NOW(),
            claimed_at = NULL,
            updated_at = NOW()
        WHERE jobs.workspace_id = ${input.workspaceId}
          AND jobs.kind = 'embedding_profile'
          AND jobs.status IN ('queued', 'processing', 'failed')
          AND NOT EXISTS (
            SELECT 1
            FROM documents d
            JOIN workspace_embedding_profiles p ON p.workspace_id = d.workspace_id
            WHERE d.id = jobs.document_id
              AND d.workspace_id = jobs.workspace_id
              AND d.revision = jobs.document_revision
              AND d.status = 'ready'
              AND d.retrieval_enabled = TRUE
              AND (d.retrieval_expires_at IS NULL OR d.retrieval_expires_at > NOW())
              AND p.generation = jobs.workspace_profile_generation
              AND jobs.embedding_space_id IN (
                p.active_embedding_space_id,
                p.pending_embedding_space_id
              )
          )
      `.execute(trx);
      const enqueued = await sql`
        INSERT INTO document_processing_jobs
          (id, document_id, workspace_id, document_revision, kind, status,
           embedding_space_id, workspace_profile_generation)
        SELECT gen_random_uuid(), d.id, d.workspace_id, d.revision,
               'embedding_profile', 'queued', spaces.embedding_space_id,
               p.generation
        FROM documents d
        JOIN workspace_embedding_profiles p ON p.workspace_id = d.workspace_id
        CROSS JOIN LATERAL (
          SELECT DISTINCT embedding_space_id
          FROM (VALUES
            (p.active_embedding_space_id),
            (p.pending_embedding_space_id)
          ) AS candidates(embedding_space_id)
          WHERE embedding_space_id IS NOT NULL
        ) spaces
        WHERE d.workspace_id = ${input.workspaceId}
          AND d.status = 'ready'
          AND d.retrieval_enabled = TRUE
          AND (d.retrieval_expires_at IS NULL OR d.retrieval_expires_at > NOW())
          AND EXISTS (
            SELECT 1
            FROM chunks c
            WHERE c.workspace_id = d.workspace_id
              AND c.document_id = d.id
              AND NOT EXISTS (
                SELECT 1
                FROM chunk_embeddings ce
                WHERE ce.workspace_id = c.workspace_id
                  AND ce.chunk_id = c.id
                  AND ce.embedding_space_id = spaces.embedding_space_id
                  AND ce.document_revision = d.revision
              )
          )
        ON CONFLICT (
          document_id, document_revision, kind, embedding_space_id,
          workspace_profile_generation
        )
          WHERE kind = 'embedding_profile'
        DO NOTHING
      `.execute(trx);
      return {
        enqueued: Number(enqueued.numAffectedRows ?? 0),
        skipped: Number(skipped.numAffectedRows ?? 0),
      };
    });
  }

  async listQueuedEmbeddingProfileJobsForWorkspace(input: {
    workspaceId: string;
    embeddingSpaceId?: string;
    generation?: string;
    limit?: number;
  }): Promise<DocumentProcessingJobRecord[]> {
    if (
      input.limit !== undefined &&
      (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 10_000)
    ) {
      throw new Error("Embedding profile dispatch limit must be between 1 and 10000");
    }
    let query = this.db
      .selectFrom("document_processing_jobs")
      .select(documentProcessingJobColumns)
      .where("workspace_id", "=", input.workspaceId)
      .where("kind", "=", "embedding_profile")
      .where("status", "=", "queued")
      .orderBy("created_at", "asc");
    if (input.embeddingSpaceId) {
      query = query.where("embedding_space_id", "=", input.embeddingSpaceId);
    }
    if (input.generation) {
      query = query.where("workspace_profile_generation", "=", input.generation);
    }
    if (input.limit !== undefined) {
      query = query.limit(input.limit);
    }
    const rows = await query.execute();
    return rows.map((row) => mapJob(row as DocumentProcessingJobRow));
  }

  async listProcessingJobs(): Promise<DocumentProcessingJobRecord[]> {
    const rows = await this.db
      .selectFrom("document_processing_jobs")
      .select(documentProcessingJobColumns)
      .where("status", "=", "processing")
      .orderBy("created_at", "asc")
      .execute();

    return rows.map((row) => mapJob(row as DocumentProcessingJobRow));
  }

  async getQueueSnapshot(now: Date = new Date()): Promise<DocumentProcessingQueueSnapshot> {
    const row = await this.db
      .selectFrom("document_processing_jobs")
      .select((eb) => [
        eb.fn.countAll<number>().filterWhere("status", "=", "queued").filterWhere("available_at", "<=", now).as("queued_job_count"),
        eb.fn.countAll<number>().filterWhere("status", "=", "processing").as("processing_job_count"),
        eb.fn.min<Date>("created_at").filterWhere("status", "=", "queued").filterWhere("available_at", "<=", now).as("oldest_queued_job_created_at"),
      ])
      .executeTakeFirst();

    return {
      queuedJobCount: Number(row?.queued_job_count ?? 0),
      processingJobCount: Number(row?.processing_job_count ?? 0),
      oldestQueuedJobCreatedAt: row?.oldest_queued_job_created_at ? new Date(row.oldest_queued_job_created_at) : null,
    };
  }

  async markCompleted(jobId: string): Promise<void> {
    await this.db
      .updateTable("document_processing_jobs")
      .set({
        status: "completed",
        completed_at: currentTimestamp(),
        updated_at: currentTimestamp(),
      })
      .where("id", "=", jobId)
      .execute();
  }

  async markSkipped(jobId: string, reason: string): Promise<void> {
    await this.db
      .updateTable("document_processing_jobs")
      .set({
        status: "skipped",
        last_error: reason,
        completed_at: currentTimestamp(),
        updated_at: currentTimestamp(),
      })
      .where("id", "=", jobId)
      .execute();
  }

  async markFailed(jobId: string, errorMessage: string): Promise<void> {
    await this.db
      .updateTable("document_processing_jobs")
      .set({
        status: "failed",
        last_error: errorMessage,
        completed_at: currentTimestamp(),
        updated_at: currentTimestamp(),
      })
      .where("id", "=", jobId)
      .execute();
  }

  async markFailedIfDocumentMatches(input: {
    jobId: string;
    documentId: string;
    workspaceId: string;
    revision: number;
    errorMessage: string;
  }): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const document = await trx
        .updateTable("documents")
        .set({
          status: "failed",
          failed_at: currentTimestamp(),
          failure_reason: input.errorMessage,
          updated_at: currentTimestamp(),
        })
        .where("id", "=", input.documentId)
        .where("workspace_id", "=", input.workspaceId)
        .where("revision", "=", input.revision)
        .returning("id")
        .executeTakeFirst();

      if (!document) {
        return false;
      }

      await trx
        .updateTable("document_processing_jobs")
        .set({
          status: "failed",
          last_error: input.errorMessage,
          completed_at: currentTimestamp(),
          updated_at: currentTimestamp(),
        })
        .where("id", "=", input.jobId)
        .execute();

      return true;
    });
  }

  async reschedule(jobId: string, nextAttemptAt: Date, errorMessage: string): Promise<void> {
    await this.db
      .updateTable("document_processing_jobs")
      .set({
        status: "queued",
        last_error: errorMessage,
        available_at: nextAttemptAt,
        claimed_at: null,
        updated_at: currentTimestamp(),
      })
      .where("id", "=", jobId)
      .execute();
  }

  async releaseTimedOutClaim(jobId: string, claimedAtOrBefore: Date, errorMessage: string): Promise<boolean> {
    const row = await this.db
      .updateTable("document_processing_jobs")
      .set({
        status: "queued",
        last_error: errorMessage,
        available_at: currentTimestamp(),
        claimed_at: null,
        updated_at: currentTimestamp(),
      })
      .where("id", "=", jobId)
      .where("status", "=", "processing")
      .where("claimed_at", "is not", null)
      .where("claimed_at", "<=", claimedAtOrBefore)
      .returning("id")
      .executeTakeFirst();

    return Boolean(row);
  }
}
