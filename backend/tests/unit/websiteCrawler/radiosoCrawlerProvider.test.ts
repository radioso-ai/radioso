import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RadiosoCrawlerProvider } from "../../../src/modules/websiteCrawler/radiosoCrawlerProvider.js";

const mocks = vi.hoisted(() => ({
  crawlSite: vi.fn(),
}));

vi.mock("@radioso/crawler", () => ({
  crawlSite: mocks.crawlSite,
}));

describe("RadiosoCrawlerProvider", () => {
  beforeEach(() => {
    mocks.crawlSite.mockReset();
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
});
