import type { CrawledPageResult } from "@radioso/crawler";

import { resolveWebsiteCrawlerConfig } from "./config.js";
import type { WebsiteCrawlPage, WebsiteCrawlRequest, WebsiteCrawlResult, WebsiteCrawlerProvider } from "./provider.js";
import { assertPublicWebsiteUrl } from "./urlPolicy.js";

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
      validateNavigationUrl: (url) => assertPublicWebsiteUrl(url),
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
    const slice = createCrawlSliceSignal(request.signal, request.maxDurationMs);
    const callbackFailure: { recorded: boolean; error: unknown } = {
      recorded: false,
      error: undefined,
    };
    const runCallback = async (callback: () => Promise<void>): Promise<void> => {
      try {
        await callback();
      } catch (error) {
        if (!callbackFailure.recorded) {
          callbackFailure.recorded = true;
          callbackFailure.error = error;
        }
        throw error;
      }
    };
    try {
      await crawlSiteStream({
        baseUrl: request.url,
        pageLimit: request.limit,
        pageConcurrency: DEFAULT_PAGE_CONCURRENCY,
        userAgent: config.userAgent,
        includeUrlPatterns: request.policy?.includeUrlPatterns,
        excludeUrlPatterns: request.policy?.excludeUrlPatterns,
        preserveContentLinks: request.policy?.preserveContentLinks,
        validateNavigationUrl: (url) => assertPublicWebsiteUrl(url),
        seedDiscoveredUrls: request.checkpoint?.discoveredUrls,
        seedPendingUrls,
        includeBaseUrl: (request.checkpoint?.discoveredUrls.length ?? 0) === 0,
        signal: slice.signal,
        onCandidateUrl: async (decision) => {
          await runCallback(async () => {
            if (decision.decision !== "accepted" || !decision.canonicalUrl) {
              return;
            }
            await request.onCheckpointEvent?.({
              type: "discovered",
              url: decision.canonicalUrl,
              canonicalUrl: decision.canonicalUrl,
            });
          });
        },
        onResult: async (page) => {
          await runCallback(async () => {
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
          });
        },
      });
      if (callbackFailure.recorded) {
        throw callbackFailure.error;
      }
      request.signal?.throwIfAborted();
    } catch (error) {
      request.signal?.throwIfAborted();
      if (callbackFailure.recorded) {
        throw callbackFailure.error;
      }
      if (!slice.isExpectedAbort(error)) {
        throw error;
      }
    } finally {
      slice.dispose();
    }

    return {
      provider: PROVIDER_NAME,
      status: "completed",
      outcome: slice.expired() ? "yielded" : "completed",
    };
  }
}

const createCrawlSliceSignal = (
  requestSignal: AbortSignal | undefined,
  maxDurationMs: number | undefined,
): {
  signal: AbortSignal | undefined;
  expired: () => boolean;
  isExpectedAbort: (error: unknown) => boolean;
  dispose: () => void;
} => {
  if (!maxDurationMs) {
    return {
      signal: requestSignal,
      expired: () => false,
      isExpectedAbort: () => false,
      dispose: () => undefined,
    };
  }

  const controller = new AbortController();
  const expirationReason = new Error("Website crawl execution slice expired");
  let sliceExpired = false;
  const abortFromRequest = () => controller.abort(requestSignal?.reason);
  if (requestSignal?.aborted) {
    abortFromRequest();
  } else {
    requestSignal?.addEventListener("abort", abortFromRequest, { once: true });
  }
  const timer = setTimeout(() => {
    sliceExpired = true;
    controller.abort(expirationReason);
  }, maxDurationMs);
  timer.unref?.();

  return {
    signal: controller.signal,
    expired: () => sliceExpired,
    isExpectedAbort: (error) => sliceExpired && error === expirationReason,
    dispose: () => {
      clearTimeout(timer);
      requestSignal?.removeEventListener("abort", abortFromRequest);
    },
  };
};

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
    return crawlSite({
      ...params,
      validateNavigationUrl: (url) => assertPublicWebsiteUrl(url),
    });
  },
  async isBrowserTransportAvailable() {
    const { isPlaywrightAvailable } = await import("@radioso/crawler");
    return isPlaywrightAvailable();
  },
  /**
   * Convert a fragment or full HTML document into clean, paragraph-structured
   * text suitable for chunking and embedding. Wraps the crawler's existing
   * structured-text extractor so connectors that ingest HTML (e.g. WordPress)
   * don't need to duplicate the rules for blocks, headings, lists, and inline
   * styles.
   */
  async extractTextFromHtml(html: string, baseUrl?: string): Promise<string> {
    const { extractStructuredTextFromHtml } = await import("@radioso/crawler");
    return extractStructuredTextFromHtml(html, baseUrl);
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
