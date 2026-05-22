import type { CrawledPageResult } from "@radioso/crawler";

import { resolveWebsiteCrawlerConfig } from "./config.js";
import type { WebsiteCrawlPage, WebsiteCrawlRequest, WebsiteCrawlResult, WebsiteCrawlerProvider } from "./provider.js";

const PROVIDER_NAME = "radioso-crawler";
const DEFAULT_PAGE_CONCURRENCY = 1;

export class RadiosoCrawlerProvider implements WebsiteCrawlerProvider {
  readonly name = PROVIDER_NAME;

  async crawl(request: WebsiteCrawlRequest): Promise<WebsiteCrawlResult> {
    const { crawlSite } = await import("@radioso/crawler");
    const config = resolveWebsiteCrawlerConfig();
    const seedPendingUrls = getSeedPendingUrls(request);
    const pages = await crawlSite({
      baseUrl: request.url,
      pageLimit: request.limit,
      pageConcurrency: DEFAULT_PAGE_CONCURRENCY,
      userAgent: config.userAgent,
      includeUrlPatterns: request.policy?.includeUrlPatterns,
      excludeUrlPatterns: request.policy?.excludeUrlPatterns,
      preserveContentLinks: request.policy?.preserveContentLinks,
      seedDiscoveredUrls: request.checkpoint?.discoveredUrls,
      seedPendingUrls,
      includeBaseUrl: (request.checkpoint?.discoveredUrls.length ?? 0) === 0,
      signal: request.signal,
    });

    return {
      provider: PROVIDER_NAME,
      status: "completed",
      pages: pages.map(toWebsiteCrawlPage),
    };
  }

  async crawlStream(
    request: WebsiteCrawlRequest,
    onPage: (page: WebsiteCrawlPage) => Promise<void>,
  ): Promise<Omit<WebsiteCrawlResult, "pages">> {
    const { crawlSiteStream } = await import("@radioso/crawler");
    const config = resolveWebsiteCrawlerConfig();
    const seedPendingUrls = getSeedPendingUrls(request);
    await crawlSiteStream({
      baseUrl: request.url,
      pageLimit: request.limit,
      pageConcurrency: DEFAULT_PAGE_CONCURRENCY,
      userAgent: config.userAgent,
      includeUrlPatterns: request.policy?.includeUrlPatterns,
      excludeUrlPatterns: request.policy?.excludeUrlPatterns,
      preserveContentLinks: request.policy?.preserveContentLinks,
      seedDiscoveredUrls: request.checkpoint?.discoveredUrls,
      seedPendingUrls,
      includeBaseUrl: (request.checkpoint?.discoveredUrls.length ?? 0) === 0,
      signal: request.signal,
      onCandidateUrl: async (decision) => {
        if (decision.decision !== "accepted" || !decision.canonicalUrl) {
          return;
        }
        await request.onCheckpointEvent?.({
          type: "discovered",
          url: decision.canonicalUrl,
          canonicalUrl: decision.canonicalUrl,
        });
      },
      onResult: async (page) => {
        await request.onCheckpointEvent?.({
          type: "processing",
          url: page.frontierUrl,
          canonicalUrl: page.url,
        });
        await onPage(toWebsiteCrawlPage(page));
        await request.onCheckpointEvent?.({
          type: "processed",
          url: page.frontierUrl,
          canonicalUrl: page.url,
        });
      },
    });

    return {
      provider: PROVIDER_NAME,
      status: "completed",
    };
  }
}

export const createRadiosoCrawlerUtilityProvider = () => ({
  async fetchPageWithScreenshot(url: string, options?: {
    signal?: AbortSignal;
    validateNavigationUrl?: (url: string) => Promise<void> | void;
    [key: string]: unknown;
  }) {
    const { fetchPageWithScreenshot } = await import("@radioso/crawler");
    return fetchPageWithScreenshot(url, options);
  },
  async crawlSite(params: {
    baseUrl: string;
    pageLimit: number;
    seedPendingUrls?: string[];
    includeBaseUrl?: boolean;
    signal?: AbortSignal;
  }) {
    const { crawlSite } = await import("@radioso/crawler");
    return crawlSite(params);
  },
  async isBrowserTransportAvailable() {
    const { isPlaywrightAvailable } = await import("@radioso/crawler");
    return isPlaywrightAvailable();
  },
});

const normalizeCheckpointUrl = (value: string): string => {
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return value;
  }
};

const getSeedPendingUrls = (request: WebsiteCrawlRequest): string[] => {
  const processedUrls = new Set((request.checkpoint?.processedCanonicalUrls ?? []).map(normalizeCheckpointUrl));
  const pendingUrls = [
    ...(request.checkpoint?.queuedUrls ?? []),
    ...(request.checkpoint?.processingUrls ?? []),
  ];
  return pendingUrls.filter((url) => !processedUrls.has(normalizeCheckpointUrl(url)));
};

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
    pageType: page.pageType ?? null,
    qualityScore: page.qualityScore ?? null,
    skipReason: page.skipReason ?? null,
    extractedContainer: page.extractedContainer ?? null,
    normalizedContentHash: page.normalizedContentHash ?? null,
    error: page.error ?? null,
  },
});
