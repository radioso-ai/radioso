import type { WebsiteCrawlJobRepositoryPort } from "../../db/repositories/websiteCrawlJobRepository.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type { WebsiteCrawlJobDispatcherPort } from "./jobDispatcher.js";
import { normalizeBaseUrl } from "./service.js";
import { assertPublicWebsiteUrl } from "./urlPolicy.js";
import type { WebsiteCrawlerDocumentIngestionPort } from "./service.js";

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
}
