import { crawlSite, type CrawledPageResult } from "@radioso/crawler";

import type { WebsiteCrawlPage, WebsiteCrawlResult, WebsiteCrawlerProvider } from "./provider.js";

const PROVIDER_NAME = "radioso-crawler";
const DEFAULT_PAGE_CONCURRENCY = 1;

export class RadiosoCrawlerProvider implements WebsiteCrawlerProvider {
  readonly name = PROVIDER_NAME;

  async crawl(request: {
    url: string;
    limit: number;
    signal?: AbortSignal;
  }): Promise<WebsiteCrawlResult> {
    const pages = await crawlSite({
      baseUrl: request.url,
      pageLimit: request.limit,
      pageConcurrency: DEFAULT_PAGE_CONCURRENCY,
      signal: request.signal,
    });

    return {
      provider: PROVIDER_NAME,
      status: "completed",
      pages: pages.map(toWebsiteCrawlPage),
    };
  }
}

const toWebsiteCrawlPage = (page: CrawledPageResult): WebsiteCrawlPage => ({
  sourceUrl: page.url,
  canonicalUrl: page.url,
  title: page.title,
  content: page.status === "success" || page.status === "unchanged" ? page.text : "",
  metadata: {
    frontierUrl: page.frontierUrl,
    crawlerStatus: page.status,
    httpStatus: page.httpStatus,
    etag: page.etag ?? null,
    lastModified: page.lastModified ?? null,
    transportUsed: page.transportUsed ?? null,
    httpAttempted: page.httpAttempted ?? null,
    browserAttempted: page.browserAttempted ?? null,
    browserFallbackReason: page.browserFallbackReason ?? null,
    httpQualityScore: page.httpQualityScore ?? null,
    error: page.error ?? null,
  },
});
