import type {
  WebsiteCrawlJobRecord,
  WebsiteCrawlJobRepositoryPort,
  WebsiteCrawlJobStatus,
} from "../../db/repositories/websiteCrawlJobRepository.js";
import { conflict, notFound } from "../../shared/domain/errors.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type { WebsiteCrawlJobDispatcherPort } from "./jobDispatcher.js";
import { normalizeBaseUrl } from "./service.js";
import { assertPublicWebsiteUrl } from "./urlPolicy.js";
import type { WebsiteCrawlerDocumentIngestionPort } from "./service.js";
import {
  DEFAULT_WEBSITE_CRAWL_POLICY,
  normalizeWebsiteCrawlPolicy,
  type WebsiteCrawlPolicy,
} from "./policy.js";

export interface CrawlPageFailure {
  sourceUrl: string;
  reason: string;
}

export interface WebsiteCrawlJobSummary {
  id: string;
  requestedUrl: string;
  status: WebsiteCrawlJobStatus;
  limit: number;
  sourceId: string | null;
  documentCount: number | null;
  failedPageCount: number | null;
  skippedPageCount: number | null;
  failures: CrawlPageFailure[];
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

const extractDocumentCount = (result: Record<string, unknown> | null): number | null => {
  if (!result) {
    return null;
  }
  const typed = result as { documentCount?: unknown; accepted?: unknown };
  if (typeof typed.documentCount === "number" && Number.isFinite(typed.documentCount)) {
    return typed.documentCount;
  }
  if (typeof typed.accepted === "number" && Number.isFinite(typed.accepted)) {
    return typed.accepted;
  }
  return null;
};

const extractFailedPageCount = (result: Record<string, unknown> | null): number | null => {
  if (!result) {
    return null;
  }
  const typed = result as { failed?: unknown };
  if (typeof typed.failed === "number" && Number.isFinite(typed.failed)) {
    return typed.failed;
  }
  return null;
};

const extractSkippedPageCount = (result: Record<string, unknown> | null): number | null => {
  if (!result) {
    return null;
  }
  const typed = result as { skipped?: unknown };
  if (typeof typed.skipped === "number" && Number.isFinite(typed.skipped)) {
    return typed.skipped;
  }
  return null;
};

const extractFailures = (result: Record<string, unknown> | null): CrawlPageFailure[] => {
  if (!result) {
    return [];
  }
  const typed = result as { failures?: unknown };
  if (!Array.isArray(typed.failures)) {
    return [];
  }
  return typed.failures
    .filter((entry): entry is { sourceUrl: string; reason: string } =>
      typeof entry === "object" && entry !== null &&
      typeof (entry as Record<string, unknown>).sourceUrl === "string" &&
      typeof (entry as Record<string, unknown>).reason === "string",
    )
    .map((entry) => ({ sourceUrl: entry.sourceUrl, reason: entry.reason }));
};

const toJobSummary = (record: WebsiteCrawlJobRecord): WebsiteCrawlJobSummary => ({
  id: record.id,
  requestedUrl: record.requestedUrl,
  status: record.status,
  limit: record.limit,
  sourceId: record.sourceId,
  documentCount: extractDocumentCount(record.result),
  failedPageCount: extractFailedPageCount(record.result),
  skippedPageCount: extractSkippedPageCount(record.result),
  failures: extractFailures(record.result),
  lastError: record.lastError,
  createdAt: record.createdAt.toISOString(),
  updatedAt: record.updatedAt.toISOString(),
  completedAt: record.completedAt ? record.completedAt.toISOString() : null,
});

export class WebsiteCrawlJobService {
  constructor(private readonly dependencies: {
    repository: WebsiteCrawlJobRepositoryPort;
    dispatcher: WebsiteCrawlJobDispatcherPort;
    documentIngestionService: WebsiteCrawlerDocumentIngestionPort;
    logger?: Pick<AppLogger, "warn">;
    assertCrawlUrlAllowed?: (url: string) => Promise<void>;
  }) {}

  async enqueue(input: {
    accountId?: string | null;
    workspaceId: string;
    url: string;
    limit: number;
    policy?: Partial<WebsiteCrawlPolicy>;
  }): Promise<{
    jobId: string;
    sourceId: string | null;
    requestedUrl: string;
    status: "queued";
  }> {
    const requestedUrl = normalizeBaseUrl(input.url);
    await (this.dependencies.assertCrawlUrlAllowed ?? assertPublicWebsiteUrl)(requestedUrl);
    const policy = normalizeWebsiteCrawlPolicy({
      ...DEFAULT_WEBSITE_CRAWL_POLICY,
      ...(input.policy ?? {}),
    });
    const source = await this.dependencies.documentIngestionService.resolveSource?.({
      workspaceId: input.workspaceId,
      source: {
        kind: "website",
        url: requestedUrl,
        config: {
          url: requestedUrl,
          limit: input.limit,
          policy,
        },
        metadata: {
          requestedUrl,
        },
      },
    }) ?? null;
    const job = await this.dependencies.repository.create({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sourceId: source?.id ?? null,
      requestedUrl,
      limit: input.limit,
      policy,
    });
    try {
      await this.dependencies.dispatcher.dispatch({
        jobId: job.id,
        workspaceId: job.workspaceId,
      });
    } catch (error) {
      this.dependencies.logger?.warn(
        {
          role: "website-crawl-job-service",
          jobId: job.id,
          workspaceId: job.workspaceId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Website crawl job dispatch failed; database polling remains active",
      );
    }

    return {
      jobId: job.id,
      sourceId: job.sourceId,
      requestedUrl: job.requestedUrl,
      status: "queued",
    };
  }

  async deleteJob(input: { workspaceId: string; jobId: string }): Promise<void> {
    const job = await this.dependencies.repository.findById(input.jobId);
    if (!job || job.workspaceId !== input.workspaceId) {
      throw notFound("Crawl job not found");
    }
    if (job.status !== "completed" && job.status !== "failed") {
      throw conflict("Crawl job is still in progress and cannot be deleted");
    }
    const deleted = await this.dependencies.repository.deleteById(input.jobId, input.workspaceId);
    if (!deleted) {
      throw notFound("Crawl job not found");
    }
  }

  async cancelJobsForSource(input: { workspaceId: string; sourceId: string }): Promise<number> {
    return this.dependencies.repository.cancelBySourceId(input.sourceId, input.workspaceId);
  }

  async pauseJobsForSource(input: { workspaceId: string; sourceId: string }): Promise<{ pausedJobCount: number }> {
    const jobs = await this.dependencies.repository.pauseBySourceId(input.sourceId, input.workspaceId);
    return { pausedJobCount: jobs.length };
  }

  async resumeJobsForSource(input: { workspaceId: string; sourceId: string }): Promise<{ resumedJobCount: number }> {
    const jobs = await this.dependencies.repository.resumePausedBySourceId(input.sourceId, input.workspaceId);
    for (const job of jobs) {
      try {
        await this.dependencies.dispatcher.dispatch({
          jobId: job.id,
          workspaceId: job.workspaceId,
        });
      } catch (error) {
        this.dependencies.logger?.warn(
          {
            role: "website-crawl-job-service",
            jobId: job.id,
            workspaceId: job.workspaceId,
            error: error instanceof Error ? error.message : String(error),
          },
          "Website crawl job resume dispatch failed; database polling remains active",
        );
      }
    }
    return { resumedJobCount: jobs.length };
  }

  async listForWorkspace(
    workspaceId: string,
    options: { status?: WebsiteCrawlJobStatus; sinceMinutes?: number; limit?: number; sourceId?: string } = {},
  ): Promise<WebsiteCrawlJobSummary[]> {
    const sinceMinutes = options.sinceMinutes;
    const since = typeof sinceMinutes === "number"
      ? new Date(Date.now() - sinceMinutes * 60_000)
      : undefined;
    const records = await this.dependencies.repository.listForWorkspace(workspaceId, {
      status: options.status,
      since,
      limit: options.limit,
      sourceId: options.sourceId,
    });
    return records.map(toJobSummary);
  }
}
