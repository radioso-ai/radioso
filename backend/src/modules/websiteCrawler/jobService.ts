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

export interface WebsiteCrawlJobSummary {
  id: string;
  requestedUrl: string;
  status: WebsiteCrawlJobStatus;
  limit: number;
  sourceId: string | null;
  documentCount: number | null;
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

const toJobSummary = (record: WebsiteCrawlJobRecord): WebsiteCrawlJobSummary => ({
  id: record.id,
  requestedUrl: record.requestedUrl,
  status: record.status,
  limit: record.limit,
  sourceId: record.sourceId,
  documentCount: extractDocumentCount(record.result),
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
  }): Promise<{
    jobId: string;
    sourceId: string | null;
    requestedUrl: string;
    status: "queued";
  }> {
    const requestedUrl = normalizeBaseUrl(input.url);
    await (this.dependencies.assertCrawlUrlAllowed ?? assertPublicWebsiteUrl)(requestedUrl);
    const source = await this.dependencies.documentIngestionService.resolveSource?.({
      workspaceId: input.workspaceId,
      source: {
        kind: "website",
        url: requestedUrl,
        config: {
          url: requestedUrl,
          limit: input.limit,
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

  async listForWorkspace(
    workspaceId: string,
    options: { status?: WebsiteCrawlJobStatus; sinceMinutes?: number; limit?: number } = {},
  ): Promise<WebsiteCrawlJobSummary[]> {
    const sinceMinutes = options.sinceMinutes;
    const since = typeof sinceMinutes === "number"
      ? new Date(Date.now() - sinceMinutes * 60_000)
      : undefined;
    const records = await this.dependencies.repository.listForWorkspace(workspaceId, {
      status: options.status,
      since,
      limit: options.limit,
    });
    return records.map(toJobSummary);
  }
}
