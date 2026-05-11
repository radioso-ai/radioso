import { randomUUID } from "node:crypto";

import type { Database } from "../../shared/infra/database.js";

export type WebsiteCrawlJobStatus = "queued" | "processing" | "completed" | "failed";

export interface WebsiteCrawlJobRecord {
  id: string;
  accountId: string | null;
  workspaceId: string;
  sourceId: string | null;
  requestedUrl: string;
  limit: number;
  status: WebsiteCrawlJobStatus;
  attemptCount: number;
  result: Record<string, unknown> | null;
  lastError: string | null;
  availableAt: Date;
  claimedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface WebsiteCrawlJobRow {
  id: string;
  account_id: string | null;
  workspace_id: string;
  source_id: string | null;
  requested_url: string;
  crawl_limit: number;
  status: WebsiteCrawlJobStatus;
  attempt_count: number;
  result_json: Record<string, unknown> | null;
  last_error: string | null;
  available_at: Date;
  claimed_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const selectWebsiteCrawlJob = `
  id,
  account_id,
  workspace_id,
  source_id,
  requested_url,
  crawl_limit,
  status,
  attempt_count,
  result_json,
  last_error,
  available_at,
  claimed_at,
  completed_at,
  created_at,
  updated_at
`;

const mapWebsiteCrawlJob = (row: WebsiteCrawlJobRow): WebsiteCrawlJobRecord => ({
  id: row.id,
  accountId: row.account_id,
  workspaceId: row.workspace_id,
  sourceId: row.source_id,
  requestedUrl: row.requested_url,
  limit: row.crawl_limit,
  status: row.status,
  attemptCount: row.attempt_count,
  result: row.result_json ?? null,
  lastError: row.last_error,
  availableAt: new Date(row.available_at),
  claimedAt: row.claimed_at ? new Date(row.claimed_at) : null,
  completedAt: row.completed_at ? new Date(row.completed_at) : null,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

export interface WebsiteCrawlJobRepositoryPort {
  create(input: {
    accountId?: string | null;
    workspaceId: string;
    sourceId?: string | null;
    requestedUrl: string;
    limit: number;
  }): Promise<WebsiteCrawlJobRecord>;
  findById(jobId: string): Promise<WebsiteCrawlJobRecord | null>;
  claimNext(now?: Date): Promise<WebsiteCrawlJobRecord | null>;
  claimById(jobId: string, now?: Date): Promise<WebsiteCrawlJobRecord | null>;
  releaseTimedOutClaim(jobId: string, claimedAtOrBefore: Date, errorMessage: string): Promise<boolean>;
  markCompleted(jobId: string, result: Record<string, unknown>): Promise<void>;
  markFailed(jobId: string, errorMessage: string): Promise<void>;
}

export class WebsiteCrawlJobRepository implements WebsiteCrawlJobRepositoryPort {
  constructor(private readonly database: Database) {}

  async create(input: {
    accountId?: string | null;
    workspaceId: string;
    sourceId?: string | null;
    requestedUrl: string;
    limit: number;
  }): Promise<WebsiteCrawlJobRecord> {
    const [row] = await this.database.query<WebsiteCrawlJobRow>(
      `INSERT INTO website_crawl_jobs (
         id,
         account_id,
         workspace_id,
         source_id,
         requested_url,
         crawl_limit,
         status
       )
       VALUES ($1, $2, $3, $4, $5, $6, 'queued')
       RETURNING ${selectWebsiteCrawlJob}`,
      [
        randomUUID(),
        input.accountId ?? null,
        input.workspaceId,
        input.sourceId ?? null,
        input.requestedUrl,
        input.limit,
      ],
    );

    return mapWebsiteCrawlJob(row!);
  }

  async findById(jobId: string): Promise<WebsiteCrawlJobRecord | null> {
    const [row] = await this.database.query<WebsiteCrawlJobRow>(
      `SELECT ${selectWebsiteCrawlJob}
       FROM website_crawl_jobs
       WHERE id = $1`,
      [jobId],
    );

    return row ? mapWebsiteCrawlJob(row) : null;
  }

  async claimNext(now: Date = new Date()): Promise<WebsiteCrawlJobRecord | null> {
    return this.database.withTransaction(async (client) => {
      const rows = await client.query<WebsiteCrawlJobRow>(
        `WITH next_job AS (
           SELECT id
           FROM website_crawl_jobs
           WHERE status = 'queued'
             AND available_at <= $1
           ORDER BY created_at ASC
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         UPDATE website_crawl_jobs jobs
         SET status = 'processing',
             attempt_count = jobs.attempt_count + 1,
             claimed_at = $1,
             updated_at = $1
         FROM next_job
         WHERE jobs.id = next_job.id
         RETURNING ${selectWebsiteCrawlJob}`,
        [now],
      );

      return rows.rows[0] ? mapWebsiteCrawlJob(rows.rows[0]) : null;
    });
  }

  async claimById(jobId: string, now: Date = new Date()): Promise<WebsiteCrawlJobRecord | null> {
    const [row] = await this.database.query<WebsiteCrawlJobRow>(
      `UPDATE website_crawl_jobs
       SET status = 'processing',
           attempt_count = attempt_count + 1,
           claimed_at = $2,
           updated_at = $2
       WHERE id = $1
         AND status = 'queued'
         AND available_at <= $2
       RETURNING ${selectWebsiteCrawlJob}`,
      [jobId, now],
    );

    return row ? mapWebsiteCrawlJob(row) : null;
  }

  async releaseTimedOutClaim(jobId: string, claimedAtOrBefore: Date, errorMessage: string): Promise<boolean> {
    const rowCount = await this.database.execute(
      `UPDATE website_crawl_jobs
       SET status = 'queued',
           claimed_at = NULL,
           last_error = $3,
           updated_at = NOW()
       WHERE id = $1
         AND status = 'processing'
         AND claimed_at <= $2`,
      [jobId, claimedAtOrBefore, errorMessage],
    );

    return rowCount > 0;
  }

  async markCompleted(jobId: string, result: Record<string, unknown>): Promise<void> {
    await this.database.execute(
      `UPDATE website_crawl_jobs
       SET status = 'completed',
           result_json = $2,
           last_error = NULL,
           completed_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [jobId, result],
    );
  }

  async markFailed(jobId: string, errorMessage: string): Promise<void> {
    await this.database.execute(
      `UPDATE website_crawl_jobs
       SET status = 'failed',
           last_error = $2,
           completed_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [jobId, errorMessage],
    );
  }
}
