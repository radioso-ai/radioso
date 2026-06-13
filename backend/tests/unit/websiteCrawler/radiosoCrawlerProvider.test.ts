import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RadiosoCrawlerProvider } from "../../../src/modules/websiteCrawler/radiosoCrawlerProvider.js";

const mocks = vi.hoisted(() => ({
  crawlSite: vi.fn(),
  crawlSiteStream: vi.fn(),
}));

vi.mock("@radioso/crawler", () => ({
  crawlSite: mocks.crawlSite,
  crawlSiteStream: mocks.crawlSiteStream,
}));

describe("RadiosoCrawlerProvider", () => {
  beforeEach(() => {
    mocks.crawlSite.mockReset();
    mocks.crawlSiteStream.mockReset();
    delete process.env.WEBSITE_CRAWLER_USER_AGENT;
  });

  afterEach(() => {
    delete process.env.WEBSITE_CRAWLER_USER_AGENT;
  });

  it("maps crawled pages into the website crawler provider contract", async () => {
    mocks.crawlSite.mockResolvedValue([{
      url: "https://example.com/docs",
      frontierUrl: "https://example.com",
      title: "Docs",
      text: "Documentation",
      html: "<main>Documentation</main>",
      httpStatus: 200,
      links: [],
      status: "success",
      etag: "\"abc\"",
      lastModified: "Wed, 01 Jan 2025 00:00:00 GMT",
      transportUsed: "http",
      httpAttempted: true,
      browserAttempted: false,
      browserFallbackReason: null,
      httpQualityScore: 0.95,
    }]);

    const provider = new RadiosoCrawlerProvider();
    const result = await provider.crawl({
      url: "https://example.com",
      limit: 5,
    });

    expect(mocks.crawlSite).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: "https://example.com",
      pageLimit: 5,
      pageConcurrency: 1,
      userAgent: "RadiosoCrawler/1.0",
      signal: undefined,
      seedPendingUrls: [],
      includeBaseUrl: true,
    }));
    expect(result).toEqual({
      provider: "radioso-crawler",
      status: "completed",
      pages: [{
        sourceUrl: "https://example.com/docs",
        canonicalUrl: "https://example.com/docs",
        title: "Docs",
        content: "Documentation",
        metadata: {
          frontierUrl: "https://example.com",
          crawlerStatus: "success",
          httpStatus: 200,
          etag: "\"abc\"",
          lastModified: "Wed, 01 Jan 2025 00:00:00 GMT",
          transportUsed: "http",
          httpAttempted: true,
          browserAttempted: false,
          browserFallbackReason: null,
          httpQualityScore: 0.95,
          pageType: null,
          qualityScore: null,
          skipReason: null,
          extractedContainer: null,
          normalizedContentHash: null,
          error: null,
        },
      }],
    });
  });

  it("passes the configured crawler user agent to the crawler package", async () => {
    process.env.WEBSITE_CRAWLER_USER_AGENT = "ExampleDocsCrawler/1.0 (+https://example.com/crawler)";
    mocks.crawlSite.mockResolvedValue([]);

    const provider = new RadiosoCrawlerProvider();
    await provider.crawl({
      url: "https://example.com",
      limit: 5,
    });

    expect(mocks.crawlSite).toHaveBeenCalledWith(expect.objectContaining({
      userAgent: "ExampleDocsCrawler/1.0 (+https://example.com/crawler)",
    }));
  });

  it("passes the public URL validator to batch and streaming crawler calls", async () => {
    mocks.crawlSite.mockResolvedValue([]);
    mocks.crawlSiteStream.mockResolvedValue({ pages: 0 });

    const provider = new RadiosoCrawlerProvider();
    await provider.crawl({
      url: "https://example.com",
      limit: 5,
    });
    await provider.crawlStream({
      url: "https://example.com",
      limit: 5,
    }, async () => {});

    const batchParams = mocks.crawlSite.mock.calls[0]?.[0] as {
      validateNavigationUrl?: (url: string) => Promise<void> | void;
    };
    const streamParams = mocks.crawlSiteStream.mock.calls[0]?.[0] as {
      validateNavigationUrl?: (url: string) => Promise<void> | void;
    };

    expect(batchParams.validateNavigationUrl).toEqual(expect.any(Function));
    expect(streamParams.validateNavigationUrl).toEqual(expect.any(Function));
    await expect(batchParams.validateNavigationUrl?.("http://127.0.0.1/")).rejects.toThrow("publicly routable host");
    await expect(streamParams.validateNavigationUrl?.("http://127.0.0.1/")).rejects.toThrow("publicly routable host");
  });

  it("does not seed already-processed checkpoint URLs back into the crawler", async () => {
    mocks.crawlSite.mockResolvedValue([]);

    const provider = new RadiosoCrawlerProvider();
    await provider.crawl({
      url: "https://example.com",
      limit: 1,
      checkpoint: {
        discoveredUrls: ["https://example.com/docs"],
        queuedUrls: ["https://example.com/docs", "https://example.com/next"],
        processingUrls: ["https://example.com/current"],
        processedCanonicalUrls: ["https://example.com/docs", "https://example.com/current"],
        accepted: 1,
        skipped: 0,
        failed: 0,
        lastProcessedAt: "2026-05-11T10:00:00.000Z",
      },
    });

    expect(mocks.crawlSite).toHaveBeenCalledWith(expect.objectContaining({
      seedPendingUrls: ["https://example.com/next"],
      includeBaseUrl: false,
    }));
  });
});
