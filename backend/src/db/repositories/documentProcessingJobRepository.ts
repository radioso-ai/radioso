import { randomUUID } from "node:crypto";

import type { Database } from "../../shared/infra/database.js";

export type DocumentProcessingJobStatus = "queued" | "processing" | "completed" | "failed" | "skipped";

export interface DocumentProcessingJobRecord {
  id: string;
  documentId: string;
  workspaceId: string;
  documentRevision: number;
  status: DocumentProcessingJobStatus;
  attemptCount: number;
  lastError: string | null;
  availableAt: Date;
  claimedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DocumentProcessingQueueSnapshot {
  queuedJobCount: number;
  processingJobCount: number;
  oldestQueuedJobCreatedAt: Date | null;
}

export interface DocumentProcessingJobRepositoryPort {
  enqueue(input: { documentId: string; workspaceId: string; documentRevision: number }): Promise<DocumentProcessingJobRecord>;
  claimNext(now?: Date): Promise<DocumentProcessingJobRecord | null>;
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
}

interface DocumentProcessingJobRow {
  id: string;
  document_id: string;
  workspace_id: string;
  document_revision: number;
  status: DocumentProcessingJobStatus;
  attempt_count: number;
  last_error: string | null;
  available_at: Date;
  claimed_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const mapJob = (row: DocumentProcessingJobRow): DocumentProcessingJobRecord => ({
  id: row.id,
  documentId: row.document_id,
  workspaceId: row.workspace_id,
  documentRevision: row.document_revision,
  status: row.status,
  attemptCount: row.attempt_count,
  lastError: row.last_error,
  availableAt: new Date(row.available_at),
  claimedAt: row.claimed_at ? new Date(row.claimed_at) : null,
  completedAt: row.completed_at ? new Date(row.completed_at) : null,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

export class DocumentProcessingJobRepository implements DocumentProcessingJobRepositoryPort {
  constructor(private readonly database: Database) {}

  async enqueue(input: { documentId: string; workspaceId: string; documentRevision: number }): Promise<DocumentProcessingJobRecord> {
    const [row] = await this.database.query<DocumentProcessingJobRow>(
      `INSERT INTO document_processing_jobs (id, document_id, workspace_id, document_revision, status)
       VALUES ($1, $2, $3, $4, 'queued')
       RETURNING id,
                 document_id,
                 workspace_id,
                 document_revision,
                 status,
                 attempt_count,
                 last_error,
                 available_at,
                 claimed_at,
                 completed_at,
                 created_at,
                 updated_at`,
      [randomUUID(), input.documentId, input.workspaceId, input.documentRevision],
    );

    return mapJob(row);
  }

  async claimNext(now: Date = new Date()): Promise<DocumentProcessingJobRecord | null> {
    return this.database.withTransaction(async (client) => {
      const rows = await client.query<DocumentProcessingJobRow>(
        `WITH next_job AS (
           SELECT id
           FROM document_processing_jobs
           WHERE status = 'queued'
             AND available_at <= $1
           ORDER BY created_at ASC
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         UPDATE document_processing_jobs jobs
         SET status = 'processing',
             attempt_count = jobs.attempt_count + 1,
             claimed_at = $1,
             updated_at = $1
         FROM next_job
         WHERE jobs.id = next_job.id
         RETURNING jobs.id,
                   jobs.document_id,
                   jobs.workspace_id,
                   jobs.document_revision,
                   jobs.status,
                   jobs.attempt_count,
                   jobs.last_error,
                   jobs.available_at,
                   jobs.claimed_at,
                   jobs.completed_at,
                   jobs.created_at,
                   jobs.updated_at`,
        [now],
      );

      return rows.rows[0] ? mapJob(rows.rows[0]) : null;
    });
  }

  async listProcessingJobs(): Promise<DocumentProcessingJobRecord[]> {
    const rows = await this.database.query<DocumentProcessingJobRow>(
      `SELECT id,
              document_id,
              workspace_id,
              document_revision,
              status,
              attempt_count,
              last_error,
              available_at,
              claimed_at,
              completed_at,
              created_at,
              updated_at
       FROM document_processing_jobs
       WHERE status = 'processing'
       ORDER BY created_at ASC`,
    );

    return rows.map(mapJob);
  }

  async getQueueSnapshot(now: Date = new Date()): Promise<DocumentProcessingQueueSnapshot> {
    const [row] = await this.database.query<{
      queued_job_count: number | string;
      processing_job_count: number | string;
      oldest_queued_job_created_at: Date | null;
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'queued' AND available_at <= $1) AS queued_job_count,
         COUNT(*) FILTER (WHERE status = 'processing') AS processing_job_count,
         MIN(created_at) FILTER (WHERE status = 'queued' AND available_at <= $1) AS oldest_queued_job_created_at
       FROM document_processing_jobs`,
      [now],
    );

    return {
      queuedJobCount: Number(row?.queued_job_count ?? 0),
      processingJobCount: Number(row?.processing_job_count ?? 0),
      oldestQueuedJobCreatedAt: row?.oldest_queued_job_created_at ? new Date(row.oldest_queued_job_created_at) : null,
    };
  }

  async markCompleted(jobId: string): Promise<void> {
    await this.database.query(
      `UPDATE document_processing_jobs
       SET status = 'completed',
           completed_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [jobId],
    );
  }

  async markSkipped(jobId: string, reason: string): Promise<void> {
    await this.database.query(
      `UPDATE document_processing_jobs
       SET status = 'skipped',
           last_error = $2,
           completed_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [jobId, reason],
    );
  }

  async markFailed(jobId: string, errorMessage: string): Promise<void> {
    await this.database.query(
      `UPDATE document_processing_jobs
       SET status = 'failed',
           last_error = $2,
           completed_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [jobId, errorMessage],
    );
  }

  async markFailedIfDocumentMatches(input: {
    jobId: string;
    documentId: string;
    workspaceId: string;
    revision: number;
    errorMessage: string;
  }): Promise<boolean> {
    return this.database.withTransaction(async (client) => {
      const documentResult = await client.query(
        `UPDATE documents
         SET status = 'failed',
             failed_at = NOW(),
             failure_reason = $4,
             updated_at = NOW()
         WHERE id = $1
           AND workspace_id = $2
           AND revision = $3
         RETURNING id`,
        [input.documentId, input.workspaceId, input.revision, input.errorMessage],
      );

      if (documentResult.rows.length === 0) {
        return false;
      }

      await client.query(
        `UPDATE document_processing_jobs
         SET status = 'failed',
             last_error = $2,
             completed_at = NOW(),
             updated_at = NOW()
         WHERE id = $1`,
        [input.jobId, input.errorMessage],
      );

      return true;
    });
  }

  async reschedule(jobId: string, nextAttemptAt: Date, errorMessage: string): Promise<void> {
    await this.database.query(
      `UPDATE document_processing_jobs
       SET status = 'queued',
           last_error = $2,
           available_at = $3,
           claimed_at = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [jobId, errorMessage, nextAttemptAt],
    );
  }
}
