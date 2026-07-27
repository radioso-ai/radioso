import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { QueryResultRow } from "pg";

import { currentTimestamp, toJsonb } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";

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
export type DocumentProcessingJobEnrichmentOverride = "on" | "off";

export interface DocumentProcessingJobOptions {
  documentEnrichmentOverride?: DocumentProcessingJobEnrichmentOverride;
}

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
