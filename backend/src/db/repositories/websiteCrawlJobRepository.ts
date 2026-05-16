import { randomUUID } from "node:crypto";

import type { Database } from "../../shared/infra/database.js";
import {
  DEFAULT_WEBSITE_CRAWL_POLICY,
  emptyWebsiteCrawlCheckpoint,
  normalizeWebsiteCrawlCheckpoint,
  normalizeWebsiteCrawlPolicy,
  type WebsiteCrawlCheckpoint,
  type WebsiteCrawlPolicy,
} from "../../modules/websiteCrawler/policy.js";

export type WebsiteCrawlJobStatus = "queued" | "processing" | "paused" | "completed" | "failed";

export interface WebsiteCrawlJobRecord {
  id: string;
  accountId: string | null;
  workspaceId: string;
  sourceId: string | null;
  requestedUrl: string;
  limit: number;
  status: WebsiteCrawlJobStatus;
  attemptCount: number;
  policy: WebsiteCrawlPolicy;
  checkpoint: WebsiteCrawlCheckpoint;
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
  policy_json: Record<string, unknown> | null;
  checkpoint_json: Record<string, unknown> | null;
  result_json: Record<string, unknown> | null;
  last_error: string | null;
  available_at: Date;
  claimed_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const websiteCrawlJobColumns = [
  "id",
  "account_id",
  "workspace_id",
  "source_id",
  "requested_url",
  "crawl_limit",
  "status",
  "attempt_count",
  "policy_json",
  "checkpoint_json",
  "result_json",
  "last_error",
  "available_at",
  "claimed_at",
  "completed_at",
  "created_at",
  "updated_at",
] as const;

const selectWebsiteCrawlJob = websiteCrawlJobColumns.join(", ");

const selectWebsiteCrawlJobAs = (alias: string): string =>
  websiteCrawlJobColumns.map((column) => `${alias}.${column}`).join(", ");

const mapWebsiteCrawlJob = (row: WebsiteCrawlJobRow): WebsiteCrawlJobRecord => ({
  id: row.id,
  accountId: row.account_id,
  workspaceId: row.workspace_id,
  sourceId: row.source_id,
  requestedUrl: row.requested_url,
  limit: row.crawl_limit,
  status: row.status,
  attemptCount: row.attempt_count,
  policy: normalizeWebsiteCrawlPolicy(row.policy_json ?? DEFAULT_WEBSITE_CRAWL_POLICY),
  checkpoint: normalizeWebsiteCrawlCheckpoint(row.checkpoint_json ?? emptyWebsiteCrawlCheckpoint()),
  result: row.result_json ?? null,
  lastError: row.last_error,
  availableAt: new Date(row.available_at),
  claimedAt: row.claimed_at ? new Date(row.claimed_at) : null,
  completedAt: row.completed_at ? new Date(row.completed_at) : null,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

export interface WebsiteCrawlJobListOptions {
  status?: WebsiteCrawlJobStatus;
  since?: Date;
  limit?: number;
  sourceId?: string;
}

export interface WebsiteCrawlJobRepositoryPort {
  create(input: {
    accountId?: string | null;
    workspaceId: string;
    sourceId?: string | null;
    requestedUrl: string;
    limit: number;
    policy?: WebsiteCrawlPolicy;
    checkpoint?: WebsiteCrawlCheckpoint;
  }): Promise<WebsiteCrawlJobRecord>;
  findById(jobId: string): Promise<WebsiteCrawlJobRecord | null>;
  listForWorkspace(workspaceId: string, options?: WebsiteCrawlJobListOptions): Promise<WebsiteCrawlJobRecord[]>;
  deleteById(jobId: string, workspaceId: string): Promise<boolean>;
  cancelBySourceId(sourceId: string, workspaceId: string): Promise<number>;
  pauseBySourceId(sourceId: string, workspaceId: string): Promise<WebsiteCrawlJobRecord[]>;
  resumePausedBySourceId(sourceId: string, workspaceId: string): Promise<WebsiteCrawlJobRecord[]>;
  updateCheckpoint(jobId: string, checkpoint: WebsiteCrawlCheckpoint): Promise<void>;
  claimNext(now?: Date): Promise<WebsiteCrawlJobRecord | null>;
  claimById(jobId: string, now?: Date): Promise<WebsiteCrawlJobRecord | null>;
  releaseTimedOutClaim(jobId: string, claimedAtOrBefore: Date, errorMessage: string): Promise<boolean>;
  releaseAllTimedOutClaims(claimedAtOrBefore: Date, errorMessage: string): Promise<number>;
  releasePausedClaim(jobId: string): Promise<void>;
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
    policy?: WebsiteCrawlPolicy;
    checkpoint?: WebsiteCrawlCheckpoint;
  }): Promise<WebsiteCrawlJobRecord> {
    const [row] = await this.database.query<WebsiteCrawlJobRow>(
      `INSERT INTO website_crawl_jobs (
         id,
         account_id,
         workspace_id,
         source_id,
         requested_url,
         crawl_limit,
         policy_json,
         checkpoint_json,
         status
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, 'queued')
       RETURNING ${selectWebsiteCrawlJob}`,
      [
        randomUUID(),
        input.accountId ?? null,
        input.workspaceId,
        input.sourceId ?? null,
        input.requestedUrl,
        input.limit,
        JSON.stringify(input.policy ?? DEFAULT_WEBSITE_CRAWL_POLICY),
        JSON.stringify(input.checkpoint ?? emptyWebsiteCrawlCheckpoint()),
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

  async deleteById(jobId: string, workspaceId: string): Promise<boolean> {
    const rowCount = await this.database.execute(
      `DELETE FROM website_crawl_jobs
       WHERE id = $1
         AND workspace_id = $2
         AND status IN ('completed', 'failed')`,
      [jobId, workspaceId],
    );
    return rowCount > 0;
  }

  async cancelBySourceId(sourceId: string, workspaceId: string): Promise<number> {
    return this.database.execute(
      `DELETE FROM website_crawl_jobs
       WHERE source_id = $1
         AND workspace_id = $2`,
      [sourceId, workspaceId],
    );
  }

  async pauseBySourceId(sourceId: string, workspaceId: string): Promise<WebsiteCrawlJobRecord[]> {
    const rows = await this.database.query<WebsiteCrawlJobRow>(
      `UPDATE website_crawl_jobs
       SET status = 'paused',
           claimed_at = CASE WHEN status = 'queued' THEN NULL ELSE claimed_at END,
           updated_at = NOW()
       WHERE source_id = $1
         AND workspace_id = $2
         AND status IN ('queued', 'processing')
       RETURNING ${selectWebsiteCrawlJob}`,
      [sourceId, workspaceId],
    );
    return rows.map(mapWebsiteCrawlJob);
  }

  async resumePausedBySourceId(sourceId: string, workspaceId: string): Promise<WebsiteCrawlJobRecord[]> {
    const rows = await this.database.query<WebsiteCrawlJobRow>(
      `UPDATE website_crawl_jobs
       SET status = 'queued',
           available_at = NOW(),
           claimed_at = NULL,
           updated_at = NOW()
       WHERE source_id = $1
         AND workspace_id = $2
         AND status = 'paused'
         AND claimed_at IS NULL
       RETURNING ${selectWebsiteCrawlJob}`,
      [sourceId, workspaceId],
    );
    return rows.map(mapWebsiteCrawlJob);
  }

  async updateCheckpoint(jobId: string, checkpoint: WebsiteCrawlCheckpoint): Promise<void> {
    await this.database.execute(
      `UPDATE website_crawl_jobs
       SET checkpoint_json = $2::jsonb,
           updated_at = NOW()
       WHERE id = $1
         AND status IN ('processing', 'paused')`,
      [jobId, JSON.stringify(checkpoint)],
    );
  }

  async listForWorkspace(
    workspaceId: string,
    options: WebsiteCrawlJobListOptions = {},
  ): Promise<WebsiteCrawlJobRecord[]> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const status = options.status ?? null;
    const since = options.since ?? null;
    const sourceId = options.sourceId ?? null;
    const rows = await this.database.query<WebsiteCrawlJobRow>(
      `SELECT ${selectWebsiteCrawlJob}
       FROM website_crawl_jobs
       WHERE workspace_id = $1
         AND ($2::text IS NULL OR status = $2)
         AND ($3::timestamptz IS NULL OR created_at >= $3)
         AND ($5::uuid IS NULL OR source_id = $5)
       ORDER BY created_at DESC
       LIMIT $4`,
      [workspaceId, status, since, limit, sourceId],
    );

    return rows.map(mapWebsiteCrawlJob);
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
         RETURNING ${selectWebsiteCrawlJobAs("jobs")}`,
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

  async releaseAllTimedOutClaims(claimedAtOrBefore: Date, errorMessage: string): Promise<number> {
    return this.database.execute(
      `UPDATE website_crawl_jobs
       SET status = 'queued',
           claimed_at = NULL,
           last_error = $2,
           updated_at = NOW()
       WHERE status = 'processing'
         AND claimed_at <= $1`,
      [claimedAtOrBefore, errorMessage],
    );
  }

  async releasePausedClaim(jobId: string): Promise<void> {
    await this.database.execute(
      `UPDATE website_crawl_jobs
       SET claimed_at = NULL,
           updated_at = NOW()
       WHERE id = $1
         AND status = 'paused'`,
      [jobId],
    );
  }

  async markCompleted(jobId: string, result: Record<string, unknown>): Promise<void> {
    await this.database.execute(
      `UPDATE website_crawl_jobs
       SET status = 'completed',
           result_json = $2,
           last_error = NULL,
           completed_at = NOW(),
           updated_at = NOW()
       WHERE id = $1
         AND status = 'processing'`,
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
       WHERE id = $1
         AND status = 'processing'`,
      [jobId, errorMessage],
    );
  }
}
