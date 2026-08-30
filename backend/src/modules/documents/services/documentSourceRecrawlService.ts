import type { DocumentSourceRepositoryPort } from "../../../db/repositories/documentSourceRepository.js";
import { badRequest, notFound } from "../../../shared/domain/errors.js";
import type { WebsiteCrawlPolicy } from "../../websiteCrawler/public.js";

export interface DocumentSourceRecrawlResult {
  jobId: string;
  sourceId: string | null;
  requestedUrl: string;
  status: "queued";
}

export interface DocumentSourceRecrawlCrawlJobsPort {
  enqueue(input: {
    accountId: string;
    workspaceId: string;
    url: string;
    limit: number;
    policy?: Partial<WebsiteCrawlPolicy>;
  }): Promise<DocumentSourceRecrawlResult>;
}

export interface DocumentSourceRecrawlCrawlerConfig {
  defaultLimit: number;
  maxLimit: number;
}

export class DocumentSourceRecrawlService {
  constructor(private readonly dependencies: {
    sourceRepository: Pick<DocumentSourceRepositoryPort, "findByIdAndWorkspaceId">;
    crawlJobs: DocumentSourceRecrawlCrawlJobsPort;
    crawlerConfig: DocumentSourceRecrawlCrawlerConfig;
  }) {}

  async recrawlSource(input: {
    accountId: string;
    workspaceId: string;
    sourceId: string;
  }): Promise<DocumentSourceRecrawlResult> {
    const source = await this.dependencies.sourceRepository.findByIdAndWorkspaceId(input.sourceId, input.workspaceId);
    if (!source) {
      throw notFound("Source not found");
    }
    if (source.kind !== "website") {
      throw badRequest("Only website sources can be recrawled");
    }

    const url = typeof source.config.url === "string" ? source.config.url : null;
    if (!url) {
      throw badRequest("Source has no configured URL");
    }

    const persistedLimit = typeof source.config.limit === "number" &&
        Number.isInteger(source.config.limit) &&
        source.config.limit > 0
      ? source.config.limit
      : this.dependencies.crawlerConfig.defaultLimit;
    const policy = source.config.policy && typeof source.config.policy === "object" && !Array.isArray(source.config.policy)
      ? source.config.policy as Partial<WebsiteCrawlPolicy>
      : undefined;

    return this.dependencies.crawlJobs.enqueue({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      url,
      limit: Math.min(persistedLimit, this.dependencies.crawlerConfig.maxLimit),
      policy,
    });
  }
}
