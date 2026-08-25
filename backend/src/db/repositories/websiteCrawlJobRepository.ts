import { randomUUID } from "node:crypto";

import {
  DEFAULT_WEBSITE_CRAWL_POLICY,
  emptyWebsiteCrawlCheckpoint,
  normalizeWebsiteCrawlCheckpoint,
  normalizeWebsiteCrawlPolicy,
  type WebsiteCrawlCheckpoint,
  type WebsiteCrawlPolicy,
} from "../../modules/websiteCrawler/policy.js";
import { currentTimestamp, toJsonb } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";

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

interface WebsiteCrawlJobResumeRow extends WebsiteCrawlJobRow {
  resume_pending: boolean;
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

export interface ResumePausedWebsiteCrawlJobsResult {
  resumedJobs: WebsiteCrawlJobRecord[];
  pendingResumeJobCount: number;
}

export interface StaleWebsiteCrawlClaimReleaseBatch {
  releasedCount: number;
  workspaceIds: string[];
  hasMore: boolean;
}

export const DEFAULT_STALE_CLAIM_RECOVERY_BATCH_SIZE = 100;
const MAX_STALE_CLAIM_RECOVERY_BATCH_SIZE = 500;

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
  findByIdAndWorkspaceId(jobId: string, workspaceId: string): Promise<WebsiteCrawlJobRecord | null>;
  listForWorkspace(workspaceId: string, options?: WebsiteCrawlJobListOptions): Promise<WebsiteCrawlJobRecord[]>;
  deleteById(jobId: string, workspaceId: string): Promise<boolean>;
  cancelBySourceId(sourceId: string, workspaceId: string): Promise<number>;
  pauseBySourceId(sourceId: string, workspaceId: string): Promise<WebsiteCrawlJobRecord[]>;
  resumePausedBySourceId(sourceId: string, workspaceId: string): Promise<ResumePausedWebsiteCrawlJobsResult>;
  updateCheckpoint(jobId: string, expectedAttemptCount: number, checkpoint: WebsiteCrawlCheckpoint): Promise<boolean>;
  releaseForContinuation(jobId: string, expectedAttemptCount: number): Promise<boolean>;
  claimNext(now?: Date): Promise<WebsiteCrawlJobRecord | null>;
  claimById(jobId: string, now?: Date): Promise<WebsiteCrawlJobRecord | null>;
  releaseTimedOutClaim(jobId: string, claimedAtOrBefore: Date, errorMessage: string): Promise<boolean>;
  releaseTimedOutClaimsBatch(
    claimedAtOrBefore: Date,
    errorMessage: string,
    limit?: number,
  ): Promise<StaleWebsiteCrawlClaimReleaseBatch>;
  releasePausedClaim(jobId: string, expectedAttemptCount: number): Promise<boolean>;
  markCompleted(jobId: string, expectedAttemptCount: number, result: Record<string, unknown>): Promise<boolean>;
  markFailed(jobId: string, expectedAttemptCount: number, errorMessage: string): Promise<boolean>;
}

export class WebsiteCrawlJobRepository implements WebsiteCrawlJobRepositoryPort {
  constructor(private readonly db: Db) {}

  async create(input: {
    accountId?: string | null;
    workspaceId: string;
    sourceId?: string | null;
    requestedUrl: string;
    limit: number;
    policy?: WebsiteCrawlPolicy;
    checkpoint?: WebsiteCrawlCheckpoint;
  }): Promise<WebsiteCrawlJobRecord> {
    const row = await this.db
      .insertInto("website_crawl_jobs")
      .values({
        id: randomUUID(),
        account_id: input.accountId ?? null,
        workspace_id: input.workspaceId,
        source_id: input.sourceId ?? null,
        requested_url: input.requestedUrl,
        crawl_limit: input.limit,
        policy_json: toJsonb(input.policy ?? DEFAULT_WEBSITE_CRAWL_POLICY),
        checkpoint_json: toJsonb(input.checkpoint ?? emptyWebsiteCrawlCheckpoint()),
        status: "queued",
      })
      .returning(websiteCrawlJobColumns)
      .executeTakeFirstOrThrow();

    return mapWebsiteCrawlJob(row as WebsiteCrawlJobRow);
  }

  async findById(jobId: string): Promise<WebsiteCrawlJobRecord | null> {
    const row = await this.db
      .selectFrom("website_crawl_jobs")
      .select(websiteCrawlJobColumns)
      .where("id", "=", jobId)
      .executeTakeFirst();

    return row ? mapWebsiteCrawlJob(row as WebsiteCrawlJobRow) : null;
  }

  async findByIdAndWorkspaceId(jobId: string, workspaceId: string): Promise<WebsiteCrawlJobRecord | null> {
    const row = await this.db
      .selectFrom("website_crawl_jobs")
      .select(websiteCrawlJobColumns)
      .where("id", "=", jobId)
      .where("workspace_id", "=", workspaceId)
      .executeTakeFirst();

    return row ? mapWebsiteCrawlJob(row as WebsiteCrawlJobRow) : null;
  }

  async deleteById(jobId: string, workspaceId: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom("website_crawl_jobs")
      .where("id", "=", jobId)
      .where("workspace_id", "=", workspaceId)
      .where("status", "in", ["completed", "failed"])
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }

  async cancelBySourceId(sourceId: string, workspaceId: string): Promise<number> {
    const result = await this.db
      .deleteFrom("website_crawl_jobs")
      .where("source_id", "=", sourceId)
      .where("workspace_id", "=", workspaceId)
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  async pauseBySourceId(sourceId: string, workspaceId: string): Promise<WebsiteCrawlJobRecord[]> {
    const rows = await this.db
      .updateTable("website_crawl_jobs")
      .set((eb) => ({
        status: "paused",
        claimed_at: eb.case().when("status", "=", "queued").then(null).else(eb.ref("claimed_at")).end(),
        resume_requested_at: null,
        updated_at: currentTimestamp(),
      }))
      .where("source_id", "=", sourceId)
      .where("workspace_id", "=", workspaceId)
      .where((eb) =>
        eb.or([
          eb("status", "in", ["queued", "processing"]),
          eb.and([eb("status", "=", "paused"), eb("resume_requested_at", "is not", null)]),
        ]),
      )
      .returning(websiteCrawlJobColumns)
      .execute();
    return rows.map((row) => mapWebsiteCrawlJob(row as WebsiteCrawlJobRow));
  }

  async resumePausedBySourceId(sourceId: string, workspaceId: string): Promise<ResumePausedWebsiteCrawlJobsResult> {
    const rows = await this.db
      .updateTable("website_crawl_jobs")
      .set((eb) => ({
        status: eb.case().when("claimed_at", "is", null).then("queued").else(eb.ref("status")).end(),
        available_at: eb.case().when("claimed_at", "is", null).then(currentTimestamp()).else(eb.ref("available_at")).end(),
        resume_requested_at: eb.case().when("claimed_at", "is", null).then(null).else(currentTimestamp()).end(),
        updated_at: currentTimestamp(),
      }))
      .where("source_id", "=", sourceId)
      .where("workspace_id", "=", workspaceId)
      .where("status", "=", "paused")
      .returning((eb) => [
        ...websiteCrawlJobColumns,
        eb("status", "=", "paused").as("resume_pending"),
      ])
      .execute();
    return {
      resumedJobs: rows.filter((row) => !row.resume_pending).map((row) => mapWebsiteCrawlJob(row as WebsiteCrawlJobResumeRow)),
      pendingResumeJobCount: rows.filter((row) => row.resume_pending).length,
    };
  }

  async updateCheckpoint(
    jobId: string,
    expectedAttemptCount: number,
    checkpoint: WebsiteCrawlCheckpoint,
  ): Promise<boolean> {
    const result = await this.db
      .updateTable("website_crawl_jobs")
      .set({
        checkpoint_json: toJsonb(checkpoint),
        updated_at: currentTimestamp(),
      })
      .where("id", "=", jobId)
      .where("status", "in", ["processing", "paused"])
      .where("attempt_count", "=", expectedAttemptCount)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }

  async releaseForContinuation(jobId: string, expectedAttemptCount: number): Promise<boolean> {
    const result = await this.db
      .updateTable("website_crawl_jobs")
      .set({
        status: "queued",
        claimed_at: null,
        available_at: currentTimestamp(),
        last_error: null,
        updated_at: currentTimestamp(),
      })
      .where("id", "=", jobId)
      .where("status", "=", "processing")
      .where("attempt_count", "=", expectedAttemptCount)
      .executeTakeFirst();

    return Number(result.numUpdatedRows) > 0;
  }

  async listForWorkspace(
    workspaceId: string,
    options: WebsiteCrawlJobListOptions = {},
  ): Promise<WebsiteCrawlJobRecord[]> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const status = options.status ?? null;
    const since = options.since ?? null;
    const sourceId = options.sourceId ?? null;
    let query = this.db
      .selectFrom("website_crawl_jobs")
      .select(websiteCrawlJobColumns)
      .where("workspace_id", "=", workspaceId)
      .orderBy("updated_at", "desc")
      .limit(limit);

    if (status) {
      query = query.where("status", "=", status);
    }
    if (since) {
      query = query.where("updated_at", ">=", since);
    }
    if (sourceId) {
      query = query.where("source_id", "=", sourceId);
    }

    const rows = await query.execute();

    return rows.map((row) => mapWebsiteCrawlJob(row as WebsiteCrawlJobRow));
  }

  async claimNext(now?: Date): Promise<WebsiteCrawlJobRecord | null> {
    return this.db.transaction().execute(async (trx) => {
      const claimTimestamp = now ?? currentTimestamp();
      const nextJob = await trx
        .selectFrom("website_crawl_jobs")
        .select("id")
        .where("status", "=", "queued")
        .where("available_at", "<=", claimTimestamp)
        .orderBy("created_at", "asc")
        .forUpdate()
        .skipLocked()
        .limit(1)
        .executeTakeFirst();

      if (!nextJob) {
        return null;
      }

      const row = await trx
        .updateTable("website_crawl_jobs")
        .set((eb) => ({
          status: "processing",
          attempt_count: eb("attempt_count", "+", 1),
          claimed_at: claimTimestamp,
          updated_at: claimTimestamp,
        }))
        .where("id", "=", nextJob.id)
        .returning(websiteCrawlJobColumns)
        .executeTakeFirst();

      return row ? mapWebsiteCrawlJob(row as WebsiteCrawlJobRow) : null;
    });
  }

  async claimById(jobId: string, now: Date = new Date()): Promise<WebsiteCrawlJobRecord | null> {
    const row = await this.db.transaction().execute((trx) =>
      trx
        .updateTable("website_crawl_jobs")
        .set((eb) => ({
          status: "processing",
          attempt_count: eb("attempt_count", "+", 1),
          claimed_at: now,
          updated_at: now,
        }))
        .where("id", "=", jobId)
        .where("status", "=", "queued")
        .where("available_at", "<=", now)
        .returning(websiteCrawlJobColumns)
        .executeTakeFirst(),
    );

    return row ? mapWebsiteCrawlJob(row as WebsiteCrawlJobRow) : null;
  }

  async releaseTimedOutClaim(jobId: string, claimedAtOrBefore: Date, errorMessage: string): Promise<boolean> {
    const result = await this.db
      .updateTable("website_crawl_jobs")
      .set({
        status: "queued",
        claimed_at: null,
        last_error: errorMessage,
        updated_at: currentTimestamp(),
      })
      .where("id", "=", jobId)
      .where("status", "=", "processing")
      .where("claimed_at", "<=", claimedAtOrBefore)
      .executeTakeFirst();

    return Number(result.numUpdatedRows) > 0;
  }

  async releaseTimedOutClaimsBatch(
    claimedAtOrBefore: Date,
    errorMessage: string,
    limit = DEFAULT_STALE_CLAIM_RECOVERY_BATCH_SIZE,
  ): Promise<StaleWebsiteCrawlClaimReleaseBatch> {
    const requestedBatchSize = Number.isFinite(limit)
      ? Math.floor(limit)
      : DEFAULT_STALE_CLAIM_RECOVERY_BATCH_SIZE;
    const batchSize = Math.min(Math.max(requestedBatchSize, 1), MAX_STALE_CLAIM_RECOVERY_BATCH_SIZE);
    return this.db.transaction().execute(async (trx) => {
      // Lock one lookahead row so hasMore reflects the same database snapshot,
      // but mutate only the bounded batch. Concurrent workers skip these locks
      // and can recover other work without double-reporting a released row.
      const staleRows = await trx
        .selectFrom("website_crawl_jobs")
        .select(["id", "workspace_id"])
        .where((eb) =>
          eb.or([
            eb.and([eb("status", "=", "processing"), eb("claimed_at", "<=", claimedAtOrBefore)]),
            eb.and([eb("status", "=", "paused"), eb("resume_requested_at", "is", null), eb("claimed_at", "<=", claimedAtOrBefore)]),
            eb.and([eb("status", "=", "paused"), eb("resume_requested_at", "is not", null), eb("resume_requested_at", "<=", claimedAtOrBefore)]),
          ]),
        )
        .orderBy("updated_at", "asc")
        .orderBy("id", "asc")
        .forUpdate()
        .skipLocked()
        .limit(batchSize + 1)
        .execute();

      const selectedIds = staleRows.slice(0, batchSize).map((row) => row.id);
      if (selectedIds.length === 0) {
        return { releasedCount: 0, workspaceIds: [], hasMore: false };
      }

      const releasedRows = await trx
        .updateTable("website_crawl_jobs")
        .set((eb) => ({
          status: eb
            .case()
            .when("status", "=", "processing")
            .then("queued")
            .when(eb.and([eb("status", "=", "paused"), eb("resume_requested_at", "is not", null)]))
            .then("queued")
            .else(eb.ref("status"))
            .end(),
          available_at: eb
            .case()
            .when(eb.or([eb("status", "=", "processing"), eb("resume_requested_at", "is not", null)]))
            .then(currentTimestamp())
            .else(eb.ref("available_at"))
            .end(),
          claimed_at: null,
          resume_requested_at: null,
          last_error: eb.case().when("status", "=", "processing").then(errorMessage).else(eb.ref("last_error")).end(),
          updated_at: currentTimestamp(),
        }))
        .where("id", "in", selectedIds)
        .returning("workspace_id")
        .execute();

      return {
        releasedCount: releasedRows.length,
        workspaceIds: [...new Set(releasedRows.map((row) => row.workspace_id))],
        hasMore: staleRows.length > batchSize,
      };
    });
  }

  async releasePausedClaim(jobId: string, expectedAttemptCount: number): Promise<boolean> {
    const result = await this.db
      .updateTable("website_crawl_jobs")
      .set((eb) => ({
        status: eb.case().when("resume_requested_at", "is", null).then("paused").else("queued").end(),
        available_at: eb.case().when("resume_requested_at", "is", null).then(eb.ref("available_at")).else(currentTimestamp()).end(),
        claimed_at: null,
        resume_requested_at: null,
        updated_at: currentTimestamp(),
      }))
      .where("id", "=", jobId)
      .where("status", "=", "paused")
      .where("attempt_count", "=", expectedAttemptCount)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }

  async markCompleted(
    jobId: string,
    expectedAttemptCount: number,
    result: Record<string, unknown>,
  ): Promise<boolean> {
    const updateResult = await this.db
      .updateTable("website_crawl_jobs")
      .set({
        status: "completed",
        result_json: toJsonb(result),
        last_error: null,
        resume_requested_at: null,
        completed_at: currentTimestamp(),
        updated_at: currentTimestamp(),
      })
      .where("id", "=", jobId)
      .where("status", "in", ["processing", "paused"])
      .where("attempt_count", "=", expectedAttemptCount)
      .executeTakeFirst();
    return Number(updateResult.numUpdatedRows) > 0;
  }

  async markFailed(jobId: string, expectedAttemptCount: number, errorMessage: string): Promise<boolean> {
    const result = await this.db
      .updateTable("website_crawl_jobs")
      .set({
        status: "failed",
        last_error: errorMessage,
        resume_requested_at: null,
        completed_at: currentTimestamp(),
        updated_at: currentTimestamp(),
      })
      .where("id", "=", jobId)
      .where("status", "=", "processing")
      .where("attempt_count", "=", expectedAttemptCount)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }
}
