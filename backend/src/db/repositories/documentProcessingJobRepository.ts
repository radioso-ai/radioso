import { randomUUID } from "node:crypto";

import { currentTimestamp, toJsonb } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";

export type DocumentProcessingJobStatus = "queued" | "processing" | "completed" | "failed" | "skipped";
// Vectorize jobs make a document queryable (chunk + embed + publish). Enrich jobs
// run the metadata-extraction LLM afterward at lower priority.
export type DocumentProcessingJobKind = "vectorize" | "enrich";
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
}

export interface DocumentProcessingQueueSnapshot {
  queuedJobCount: number;
  processingJobCount: number;
  oldestQueuedJobCreatedAt: Date | null;
}

export interface DocumentProcessingJobRepositoryPort {
  enqueue(input: { documentId: string; workspaceId: string; documentRevision: number; kind?: DocumentProcessingJobKind; options?: DocumentProcessingJobOptions | null }): Promise<DocumentProcessingJobRecord>;
  findById(jobId: string): Promise<DocumentProcessingJobRecord | null>;
  findByDocumentRevision(input: { documentId: string; workspaceId: string; documentRevision: number }): Promise<DocumentProcessingJobRecord | null>;
  claimNext(now?: Date): Promise<DocumentProcessingJobRecord | null>;
  claimById(jobId: string, now?: Date): Promise<DocumentProcessingJobRecord | null>;
  backfillMissingQueuedJobs(limit?: number): Promise<number>;
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
});

const normalizeJobKind = (value: unknown): DocumentProcessingJobKind =>
  value === "enrich" ? "enrich" : "vectorize";

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
] as const;

export class DocumentProcessingJobRepository implements DocumentProcessingJobRepositoryPort {
  constructor(private readonly db: Db) {}

  async enqueue(input: { documentId: string; workspaceId: string; documentRevision: number; kind?: DocumentProcessingJobKind; options?: DocumentProcessingJobOptions | null }): Promise<DocumentProcessingJobRecord> {
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
        // Vectorize jobs make a document queryable; drain them before the
        // lower-priority enrich (metadata-extraction) jobs. `(kind = 'enrich')`
        // sorts vectorize (false) ahead of enrich (true).
        .orderBy((eb) => eb("kind", "=", "enrich"), "asc")
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
