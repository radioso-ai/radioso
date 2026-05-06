import { describe, expect, it, vi } from "vitest";

import { EnterpriseWebsiteCrawlerService } from "./service.js";
import type { WebsiteCrawlerProvider } from "./provider.js";
import { WebsiteCrawlerBadRequestError, WebsiteCrawlerProviderError } from "./errors.js";

const createProvider = (pages: Awaited<ReturnType<WebsiteCrawlerProvider["crawl"]>>["pages"]): WebsiteCrawlerProvider => ({
  name: "fake",
  async crawl() {
    return {
      provider: "fake",
      runId: "run-1",
      status: "completed",
      pages,
    };
  },
});

describe("enterprise website crawler service", () => {
  it("publishes unique provider pages through document ingestion", async () => {
    const ingest = vi.fn()
      .mockResolvedValueOnce({ documentId: "doc-1", status: "queued" })
      .mockResolvedValueOnce({ documentId: "doc-2", status: "queued" });
    const service = new EnterpriseWebsiteCrawlerService({
      provider: createProvider([
        {
          sourceUrl: "https://example.com/about?utm_source=x",
          canonicalUrl: "https://example.com/about",
          title: "About",
          content: "# About",
          metadata: { statusCode: 200 },
        },
        {
          sourceUrl: "https://example.com/about",
          canonicalUrl: "https://example.com/about",
          title: "Duplicate About",
          content: "# Duplicate",
          metadata: { statusCode: 200 },
        },
        {
          sourceUrl: "https://example.com/contact",
          title: null,
          content: "# Contact",
          metadata: { statusCode: 200 },
        },
      ]),
      documentIngestionService: { ingest },
      auditService: { record: vi.fn() },
      assertCrawlUrlAllowed: async () => undefined,
    });

    const result = await service.crawlAndPublish({
      accountId: "account-1",
      workspaceId: "workspace-1",
      url: "https://example.com",
      limit: 5,
    });

    expect(result.accepted).toBe(2);
    expect(result.failed).toBe(0);
    expect(ingest).toHaveBeenCalledTimes(2);
    expect(ingest.mock.calls[0][0]).toEqual(expect.objectContaining({
      accountId: "account-1",
      workspaceId: "workspace-1",
      title: "About",
      content: "# About",
      externalDocumentId: "website:https://example.com:https://example.com/about",
      metadata: expect.objectContaining({
        sourceKind: "website",
        sourceUrl: "https://example.com/about?utm_source=x",
        canonicalUrl: "https://example.com/about",
        websiteBaseUrl: "https://example.com",
        websiteCrawlerProvider: "fake",
        websiteCrawlerRunId: "run-1",
      }),
    }));
    expect(ingest.mock.calls[1][0]).toEqual(expect.objectContaining({
      title: "https://example.com/contact",
      externalDocumentId: "website:https://example.com:https://example.com/contact",
    }));
  });

  it("uses stable external document IDs for repeated crawls", async () => {
    const ingest = vi.fn().mockResolvedValue({ documentId: "doc-1", status: "queued" });
    const service = new EnterpriseWebsiteCrawlerService({
      provider: createProvider([
        {
          sourceUrl: "https://example.com/about?utm_source=x",
          canonicalUrl: "https://example.com/about",
          title: "About",
          content: "# About",
          metadata: {},
        },
      ]),
      documentIngestionService: { ingest },
      auditService: { record: vi.fn() },
      assertCrawlUrlAllowed: async () => undefined,
    });

    await service.crawlAndPublish({ workspaceId: "workspace-1", url: "https://example.com", limit: 1 });
    await service.crawlAndPublish({ workspaceId: "workspace-1", url: "https://example.com/", limit: 1 });

    expect(ingest.mock.calls[0][0].externalDocumentId).toBe(ingest.mock.calls[1][0].externalDocumentId);
  });

  it("reports page publication failures without leaking provider metadata", async () => {
    const ingest = vi.fn()
      .mockResolvedValueOnce({ documentId: "doc-1", status: "queued" })
      .mockRejectedValueOnce(new Error("database unavailable"));
    const service = new EnterpriseWebsiteCrawlerService({
      provider: createProvider([
        { sourceUrl: "https://example.com/a", title: "A", content: "A", metadata: { token: "crawler-secret" } },
        { sourceUrl: "https://example.com/b", title: "B", content: "B", metadata: { token: "crawler-secret" } },
      ]),
      documentIngestionService: { ingest },
      auditService: { record: vi.fn() },
      assertCrawlUrlAllowed: async () => undefined,
    });

    const result = await service.crawlAndPublish({
      workspaceId: "workspace-1",
      url: "https://example.com",
      limit: 2,
    });

    expect(result.accepted).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.failures[0]).toEqual({
      sourceUrl: "https://example.com/b",
      reason: "Failed to publish crawled page",
    });
    expect(JSON.stringify(result)).not.toContain("crawler-secret");
  });

  it("normalizes provider failures before they cross the crawler boundary", async () => {
    const auditService = { record: vi.fn() };
    const service = new EnterpriseWebsiteCrawlerService({
      provider: {
        name: "Bearer sk_live_providersecret",
        async crawl() {
          throw new Error("provider failed token=crawler-secret at https://user:pass@crawler.example");
        },
      },
      documentIngestionService: {
        ingest: vi.fn(),
      },
      auditService,
      assertCrawlUrlAllowed: async () => undefined,
    });

    await expect(service.crawlAndPublish({
      workspaceId: "workspace-1",
      url: "https://example.com",
      limit: 1,
    })).rejects.toMatchObject({
      code: "website_crawler_provider_failed",
      statusCode: 502,
      message: "provider failed [redacted] at https://[redacted]@crawler.example",
      details: {
        provider: "Bearer [redacted]",
      },
    });
    expect(auditService.record).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "ee.website_crawler.crawl",
      eventStatus: "failure",
      metadata: expect.objectContaining({
        provider: "Bearer [redacted]",
        failureCode: "website_crawler_provider_failed",
      }),
    }));
  });

  it("audits URL policy failures with the original bad request code", async () => {
    const auditService = { record: vi.fn() };
    const provider = createProvider([]);
    const crawl = vi.spyOn(provider, "crawl");
    const service = new EnterpriseWebsiteCrawlerService({
      provider,
      documentIngestionService: { ingest: vi.fn() },
      auditService,
      assertCrawlUrlAllowed: async () => {
        throw new WebsiteCrawlerBadRequestError("Website URL must resolve to a publicly routable host");
      },
    });

    await expect(service.crawlAndPublish({
      workspaceId: "workspace-1",
      url: "https://example.com",
      limit: 1,
    })).rejects.toMatchObject({
      code: "bad_request",
      statusCode: 400,
    });

    expect(crawl).not.toHaveBeenCalled();
    expect(auditService.record).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "ee.website_crawler.crawl",
      eventStatus: "failure",
      metadata: expect.objectContaining({
        failureCode: "bad_request",
        failureStatusCode: 400,
      }),
    }));
  });

  it("rejects credential-bearing URLs before provider calls or persistence", async () => {
    const provider = createProvider([]);
    const crawl = vi.spyOn(provider, "crawl");
    const ingest = vi.fn();
    const service = new EnterpriseWebsiteCrawlerService({
      provider,
      documentIngestionService: { ingest },
      auditService: { record: vi.fn() },
      assertCrawlUrlAllowed: async () => undefined,
    });

    await expect(service.crawlAndPublish({
      workspaceId: "workspace-1",
      url: "https://user:crawler-secret@example.com",
      limit: 1,
    })).rejects.toThrow("URL must not include credentials");
    expect(crawl).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
  });

  it("does not return or persist provider source URLs with credentials", async () => {
    const ingest = vi.fn().mockResolvedValue({ documentId: "doc-1", status: "queued" });
    const service = new EnterpriseWebsiteCrawlerService({
      provider: createProvider([
        {
          sourceUrl: "https://user:crawler-secret@example.com/a",
          canonicalUrl: "https://example.com/a",
          title: "A",
          content: "A",
          metadata: {},
        },
      ]),
      documentIngestionService: { ingest },
      auditService: { record: vi.fn() },
      assertCrawlUrlAllowed: async () => undefined,
    });

    const result = await service.crawlAndPublish({
      workspaceId: "workspace-1",
      url: "https://example.com",
      limit: 1,
    });

    expect(ingest).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("crawler-secret");
    expect(result.failures).toEqual([{
      sourceUrl: "invalid-url",
      reason: "Page URL was invalid",
    }]);
  });

  it("keeps trusted website metadata from being overridden by provider metadata", async () => {
    const ingest = vi.fn().mockResolvedValue({ documentId: "doc-1", status: "queued" });
    const service = new EnterpriseWebsiteCrawlerService({
      provider: createProvider([
        {
          sourceUrl: "https://example.com/a",
          canonicalUrl: "https://example.com/a",
          title: "A",
          content: "A",
          metadata: {
            sourceKind: "provider-value",
            sourceUrl: "https://attacker.example",
            canonicalUrl: "https://attacker.example",
            websiteBaseUrl: "https://attacker.example",
            websiteCrawlerProvider: "attacker",
            key: "crawler-secret",
            password: "crawler-secret",
            signature: "crawler-secret",
            credential: "crawler-secret",
            sig: "crawler-secret",
            request: {
              authorization: "Bearer crawler-secret",
              credential: "crawler-secret",
              signature: "crawler-secret",
              nested: "token=crawler-secret",
            },
            safeField: "safe",
          },
        },
      ]),
      documentIngestionService: { ingest },
      auditService: { record: vi.fn() },
      assertCrawlUrlAllowed: async () => undefined,
    });

    await service.crawlAndPublish({
      workspaceId: "workspace-1",
      url: "https://example.com",
      limit: 1,
    });

    expect(ingest.mock.calls[0][0].metadata).toEqual(expect.objectContaining({
      sourceKind: "website",
      sourceUrl: "https://example.com/a",
      canonicalUrl: "https://example.com/a",
      websiteBaseUrl: "https://example.com",
      websiteCrawlerProvider: "fake",
      safeField: "safe",
    }));
    expect(JSON.stringify(ingest.mock.calls[0][0].metadata)).not.toContain("crawler-secret");
  });

  it("redacts provider-controlled identifiers in responses, audits, and metadata", async () => {
    const ingest = vi.fn().mockResolvedValue({ documentId: "doc-1", status: "queued" });
    const auditService = { record: vi.fn() };
    const service = new EnterpriseWebsiteCrawlerService({
      provider: {
        name: "custom-crawler",
        async crawl() {
          return {
            provider: "custom-crawler token=crawler-secret",
            runId: "Bearer sk_live_runsecret",
            status: "apiKey=crawler-secret",
            pages: [
              { sourceUrl: "https://example.com/a", content: "A" },
            ],
          };
        },
      },
      documentIngestionService: { ingest },
      auditService,
      assertCrawlUrlAllowed: async () => undefined,
    });

    const result = await service.crawlAndPublish({
      workspaceId: "workspace-1",
      url: "https://example.com",
      limit: 1,
    });

    expect(JSON.stringify(result)).not.toContain("crawler-secret");
    expect(JSON.stringify(result)).not.toContain("sk_live_runsecret");
    expect(JSON.stringify(ingest.mock.calls[0][0].metadata)).not.toContain("crawler-secret");
    expect(JSON.stringify(ingest.mock.calls[0][0].metadata)).not.toContain("sk_live_runsecret");
    expect(JSON.stringify(auditService.record.mock.calls[0][0].metadata)).not.toContain("crawler-secret");
    expect(JSON.stringify(auditService.record.mock.calls[0][0].metadata)).not.toContain("sk_live_runsecret");
  });

  it("redacts secret URL query values before publication and audit output", async () => {
    const ingest = vi.fn().mockResolvedValue({ documentId: "doc-1", status: "queued" });
    const auditService = { record: vi.fn() };
    const service = new EnterpriseWebsiteCrawlerService({
      provider: {
        name: "custom-crawler",
        async crawl() {
          return {
            provider: "custom-crawler",
            pages: [
              {
                sourceUrl: "https://example.com/page?token=crawler-secret&signature=signed-secret&topic=docs",
                canonicalUrl: "https://example.com/page?apiKey=crawler-secret&sig=signed-secret&topic=docs",
                content: "A",
              },
            ],
          };
        },
      },
      documentIngestionService: { ingest },
      auditService,
      assertCrawlUrlAllowed: async () => undefined,
    });

    const result = await service.crawlAndPublish({
      workspaceId: "workspace-1",
      url: "https://example.com/search?apiKey=crawler-secret&q=docs",
      limit: 1,
    });

    expect(JSON.stringify(result)).not.toContain("crawler-secret");
    expect(JSON.stringify(result)).not.toContain("signed-secret");
    expect(JSON.stringify(ingest.mock.calls[0][0])).not.toContain("crawler-secret");
    expect(JSON.stringify(ingest.mock.calls[0][0])).not.toContain("signed-secret");
    expect(JSON.stringify(auditService.record.mock.calls[0][0].metadata)).not.toContain("crawler-secret");
    expect(JSON.stringify(auditService.record.mock.calls[0][0].metadata)).not.toContain("signed-secret");
    expect(result.requestedUrl).toContain("apiKey=%5Bredacted%5D");
    expect(result.requestedUrl).toContain("q=docs");
    expect(result.documents[0]?.sourceUrl).toContain("token=%5Bredacted%5D");
    expect(result.documents[0]?.sourceUrl).toContain("signature=%5Bredacted%5D");
    expect(result.documents[0]?.sourceUrl).toContain("topic=docs");
    expect(result.documents[0]?.externalDocumentId).not.toContain("crawler-secret");
    expect(result.documents[0]?.externalDocumentId).not.toContain("signed-secret");
    expect(ingest.mock.calls[0][0].metadata).toEqual(expect.objectContaining({
      sourceUrl: "https://example.com/page?token=%5Bredacted%5D&signature=%5Bredacted%5D&topic=docs",
      canonicalUrl: "https://example.com/page?apiKey=%5Bredacted%5D&sig=%5Bredacted%5D&topic=docs",
      websiteBaseUrl: "https://example.com/search?apiKey=%5Bredacted%5D&q=docs",
    }));
  });

  it("preserves crawl request query strings when calling the provider", async () => {
    const crawl = vi.fn().mockResolvedValue({
      provider: "custom-crawler",
      pages: [],
    });
    const service = new EnterpriseWebsiteCrawlerService({
      provider: {
        name: "custom-crawler",
        crawl,
      },
      documentIngestionService: { ingest: vi.fn() },
      auditService: { record: vi.fn() },
      assertCrawlUrlAllowed: async () => undefined,
    });

    const result = await service.crawlAndPublish({
      workspaceId: "workspace-1",
      url: "https://example.com/search?q=api",
      limit: 1,
    });

    expect(crawl).toHaveBeenCalledWith({
      url: "https://example.com/search?q=api",
      limit: 1,
    });
    expect(result.requestedUrl).toBe("https://example.com/search?q=api");
  });

  it("passes request cancellation signals into the abstract provider", async () => {
    const signal = new AbortController().signal;
    const crawl = vi.fn().mockResolvedValue({
      provider: "custom-crawler",
      pages: [],
    });
    const service = new EnterpriseWebsiteCrawlerService({
      provider: {
        name: "custom-crawler",
        crawl,
      },
      documentIngestionService: { ingest: vi.fn() },
      auditService: { record: vi.fn() },
      assertCrawlUrlAllowed: async () => undefined,
    });

    await service.crawlAndPublish({
      workspaceId: "workspace-1",
      url: "https://example.com",
      limit: 1,
      signal,
    });

    expect(crawl).toHaveBeenCalledWith({
      url: "https://example.com",
      limit: 1,
      signal,
    });
  });

  it("stops before provider calls when the request signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const crawl = vi.fn();
    const service = new EnterpriseWebsiteCrawlerService({
      provider: {
        name: "custom-crawler",
        crawl,
      },
      documentIngestionService: { ingest: vi.fn() },
      auditService: { record: vi.fn() },
      assertCrawlUrlAllowed: async () => undefined,
    });

    await expect(service.crawlAndPublish({
      workspaceId: "workspace-1",
      url: "https://example.com",
      limit: 1,
      signal: controller.signal,
    })).rejects.toThrow("request was aborted");
    expect(crawl).not.toHaveBeenCalled();
  });

  it("normalizes invalid abstract provider results into provider errors", async () => {
    const service = new EnterpriseWebsiteCrawlerService({
      provider: {
        name: "custom-crawler",
        async crawl() {
          return { provider: "custom-crawler", pages: null } as never;
        },
      },
      documentIngestionService: { ingest: vi.fn() },
      auditService: { record: vi.fn() },
      assertCrawlUrlAllowed: async () => undefined,
    });

    await expect(service.crawlAndPublish({
      workspaceId: "workspace-1",
      url: "https://example.com",
      limit: 1,
    })).rejects.toMatchObject({
      code: "website_crawler_provider_failed",
      statusCode: 502,
    });
  });

  it("counts invalid provider page entries before publication", async () => {
    const ingest = vi.fn().mockResolvedValue({ documentId: "doc-1", status: "queued" });
    const service = new EnterpriseWebsiteCrawlerService({
      provider: {
        name: "custom-crawler",
        async crawl() {
          return {
            provider: "custom-crawler",
            pages: [
              null,
              { sourceUrl: "https://example.com/missing-content" },
              { sourceUrl: "https://example.com/a", content: "A" },
            ],
          } as never;
        },
      },
      documentIngestionService: { ingest },
      auditService: { record: vi.fn() },
      assertCrawlUrlAllowed: async () => undefined,
    });

    const result = await service.crawlAndPublish({
      workspaceId: "workspace-1",
      url: "https://example.com",
      limit: 3,
    });

    expect(result.accepted).toBe(1);
    expect(result.failed).toBe(2);
    expect(result.failures).toEqual([
      {
        sourceUrl: "invalid-provider-page",
        reason: "Provider returned an invalid page result",
      },
      {
        sourceUrl: "invalid-provider-page",
        reason: "Provider returned an invalid page result",
      },
    ]);
    expect(ingest).toHaveBeenCalledTimes(1);
  });

  it("enforces local page limits and accounts for malformed provider page URLs", async () => {
    const ingest = vi.fn().mockResolvedValue({ documentId: "doc-1", status: "queued" });
    const service = new EnterpriseWebsiteCrawlerService({
      provider: createProvider([
        { sourceUrl: "https://example.com/a", title: "A", content: "A", metadata: {} },
        { sourceUrl: "not a url", title: "Bad", content: "Bad", metadata: {} },
        { sourceUrl: "https://example.com/b", title: "B", content: "B", metadata: {} },
        { sourceUrl: "https://example.com/c", title: "C", content: "C", metadata: {} },
      ]),
      documentIngestionService: { ingest },
      auditService: { record: vi.fn() },
      assertCrawlUrlAllowed: async () => undefined,
    });

    const result = await service.crawlAndPublish({
      workspaceId: "workspace-1",
      url: "https://example.com",
      limit: 2,
    });

    expect(ingest).toHaveBeenCalledTimes(1);
    expect(ingest.mock.calls.map((call) => call[0].title)).toEqual(["A"]);
    expect(result.accepted).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.failures).toContainEqual({
      sourceUrl: "invalid-url",
      reason: "Page URL was invalid",
    });
  });
});
