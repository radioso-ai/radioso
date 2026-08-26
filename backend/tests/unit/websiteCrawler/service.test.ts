import { afterEach, describe, expect, it, vi } from "vitest";

import {
  WEBSITE_CRAWL_CHECKPOINT_PERSIST_INTERVAL_MS,
  WebsiteCrawlerService,
} from "../../../src/modules/websiteCrawler/service.js";
import type { WebsiteCrawlerProvider } from "../../../src/modules/websiteCrawler/provider.js";
import { WebsiteCrawlerBadRequestError, WebsiteCrawlerProviderError } from "../../../src/modules/websiteCrawler/errors.js";

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

const createCheckpointFlushTestService = (
  crawlStream: NonNullable<WebsiteCrawlerProvider["crawlStream"]>,
): WebsiteCrawlerService => new WebsiteCrawlerService({
  provider: {
    name: "stream-crawler",
    crawl: vi.fn(),
    crawlStream,
  },
  documentIngestionService: { ingest: vi.fn() },
  assertCrawlUrlAllowed: async () => undefined,
});

describe("website crawler service", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces rapid frontier checkpoint events into one persistence within the interval", async () => {
    vi.useFakeTimers();
    let finishCrawl: (() => void) | undefined;
    const checkpoints: unknown[] = [];
    const service = new WebsiteCrawlerService({
      provider: {
        name: "stream-crawler",
        crawl: vi.fn(),
        crawlStream: vi.fn(async (request) => {
          await request.onCheckpointEvent?.({ type: "discovered", url: "https://example.com/a", canonicalUrl: "https://example.com/a" });
          await request.onCheckpointEvent?.({ type: "processing", url: "https://example.com/a", canonicalUrl: "https://example.com/a" });
          await request.onCheckpointEvent?.({ type: "processed", url: "https://example.com/a", canonicalUrl: "https://example.com/a" });
          await new Promise<void>((resolve) => { finishCrawl = resolve; });
          return { provider: "stream-crawler", status: "completed" };
        }),
      },
      documentIngestionService: { ingest: vi.fn() },
      assertCrawlUrlAllowed: async () => undefined,
    });
    const crawl = service.crawlAndPublish({ workspaceId: "workspace-1", url: "https://example.com", limit: 5, onCheckpoint: async (checkpoint) => { checkpoints.push(checkpoint); } });
    await vi.advanceTimersByTimeAsync(WEBSITE_CRAWL_CHECKPOINT_PERSIST_INTERVAL_MS - 1);
    expect(checkpoints).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(checkpoints).toEqual([expect.objectContaining({ queuedUrls: [], processingUrls: [], processedCanonicalUrls: ["https://example.com/a"] })]);
    finishCrawl?.();
    await crawl;
    expect(checkpoints).toHaveLength(1);
  });

  it("flushes the final checkpoint on normal completion", async () => {
    vi.useFakeTimers();
    const checkpoints: unknown[] = [];
    const service = createCheckpointFlushTestService(async (request) => {
      await request.onCheckpointEvent?.({ type: "discovered", url: "https://example.com/completed", canonicalUrl: "https://example.com/completed" });
      return { provider: "stream-crawler", status: "completed" };
    });
    const crawl = service.crawlAndPublish({ workspaceId: "workspace-1", url: "https://example.com", limit: 5, onCheckpoint: async (checkpoint) => { checkpoints.push(checkpoint); } });
    await vi.advanceTimersByTimeAsync(0);
    await expect(crawl).resolves.toMatchObject({ outcome: "completed" });
    expect(checkpoints).toEqual([expect.objectContaining({ queuedUrls: ["https://example.com/completed"] })]);
  });

  it("writes the final checkpoint immediately without waiting for the throttle interval", async () => {
    vi.useFakeTimers();
    const checkpoints: unknown[] = [];
    const service = createCheckpointFlushTestService(async (request) => {
      await request.onCheckpointEvent?.({ type: "discovered", url: "https://example.com/immediate", canonicalUrl: "https://example.com/immediate" });
      return { provider: "stream-crawler", status: "completed" };
    });
    const crawl = service.crawlAndPublish({ workspaceId: "workspace-1", url: "https://example.com", limit: 5, onCheckpoint: async (checkpoint) => { checkpoints.push(checkpoint); } });
    await vi.advanceTimersByTimeAsync(0);
    expect(checkpoints).toEqual([expect.objectContaining({ queuedUrls: ["https://example.com/immediate"] })]);
    await expect(crawl).resolves.toMatchObject({ outcome: "completed" });
  });

  it("surfaces a timer-triggered checkpoint persistence error at terminal flush", async () => {
    vi.useFakeTimers();
    const checkpointError = new Error("checkpoint write failed");
    let finishCrawl: (() => void) | undefined;
    const service = createCheckpointFlushTestService(async (request) => {
      await request.onCheckpointEvent?.({ type: "discovered", url: "https://example.com/rejected-checkpoint", canonicalUrl: "https://example.com/rejected-checkpoint" });
      await new Promise<void>((resolve) => { finishCrawl = resolve; });
      return { provider: "stream-crawler", status: "completed" };
    });
    const crawl = service.crawlAndPublish({ workspaceId: "workspace-1", url: "https://example.com", limit: 5, onCheckpoint: async () => { throw checkpointError; } });
    await vi.advanceTimersByTimeAsync(WEBSITE_CRAWL_CHECKPOINT_PERSIST_INTERVAL_MS);
    finishCrawl?.();
    await expect(crawl).rejects.toBe(checkpointError);
  });

  it("flushes the final checkpoint before yielding a crawl slice", async () => {
    vi.useFakeTimers();
    const checkpoints: unknown[] = [];
    const service = createCheckpointFlushTestService(async (request) => {
      await request.onCheckpointEvent?.({ type: "discovered", url: "https://example.com/yielded", canonicalUrl: "https://example.com/yielded" });
      return { provider: "stream-crawler", outcome: "yielded" };
    });
    const crawl = service.crawlAndPublish({ workspaceId: "workspace-1", url: "https://example.com", limit: 5, onCheckpoint: async (checkpoint) => { checkpoints.push(checkpoint); } });
    await vi.advanceTimersByTimeAsync(0);
    await expect(crawl).resolves.toMatchObject({ outcome: "yielded" });
    expect(checkpoints).toEqual([expect.objectContaining({ queuedUrls: ["https://example.com/yielded"] })]);
  });

  it("flushes the final checkpoint when cancellation aborts the crawl", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const checkpoints: unknown[] = [];
    const service = createCheckpointFlushTestService(async (request) => {
      await request.onCheckpointEvent?.({ type: "discovered", url: "https://example.com/cancelled", canonicalUrl: "https://example.com/cancelled" });
      controller.abort();
      return { provider: "stream-crawler", status: "cancelled" };
    });
    const crawl = service.crawlAndPublish({ workspaceId: "workspace-1", url: "https://example.com", limit: 5, signal: controller.signal, onCheckpoint: async (checkpoint) => { checkpoints.push(checkpoint); } });
    const rejected = expect(crawl).rejects.toThrow("request was aborted");
    await vi.advanceTimersByTimeAsync(0);
    await rejected;
    expect(checkpoints).toEqual([expect.objectContaining({ queuedUrls: ["https://example.com/cancelled"] })]);
  });

  it("flushes the final checkpoint when the provider fails", async () => {
    vi.useFakeTimers();
    const providerError = new Error("stream failed");
    const checkpoints: unknown[] = [];
    const service = createCheckpointFlushTestService(async (request) => {
      await request.onCheckpointEvent?.({ type: "discovered", url: "https://example.com/failed", canonicalUrl: "https://example.com/failed" });
      throw providerError;
    });
    const crawl = service.crawlAndPublish({ workspaceId: "workspace-1", url: "https://example.com", limit: 5, onCheckpoint: async (checkpoint) => { checkpoints.push(checkpoint); } });
    const rejected = expect(crawl).rejects.toBe(providerError);
    await vi.advanceTimersByTimeAsync(0);
    await rejected;
    expect(checkpoints).toEqual([expect.objectContaining({ queuedUrls: ["https://example.com/failed"] })]);
  });

  it("preserves the crawl failure when terminal checkpoint persistence also fails", async () => {
    const crawlError = new WebsiteCrawlerProviderError("stream failed", { provider: "stream-crawler" });
    const checkpointError = new Error("checkpoint write failed token=checkpoint-secret");
    const record = vi.fn();
    const updateSourceSyncState = vi.fn().mockResolvedValue(undefined);
    const logger = { warn: vi.fn() };
    const service = new WebsiteCrawlerService({
      provider: {
        name: "stream-crawler",
        crawl: vi.fn(),
        crawlStream: vi.fn(async (request) => {
          await request.onCheckpointEvent?.({
            type: "discovered",
            url: "https://example.com/failed",
            canonicalUrl: "https://example.com/failed",
          });
          throw crawlError;
        }),
      },
      documentIngestionService: {
        ingest: vi.fn(),
        resolveSource: vi.fn().mockResolvedValue({ id: "source-1" }),
        updateSourceSyncState,
      },
      auditService: { record },
      logger,
      assertCrawlUrlAllowed: async () => undefined,
    });

    await expect(service.crawlAndPublish({
      workspaceId: "workspace-1",
      url: "https://example.com",
      limit: 1,
      onCheckpoint: async () => { throw checkpointError; },
    })).rejects.toBe(crawlError);

    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "document.website_crawler.crawl",
      eventStatus: "failure",
    }));
    expect(updateSourceSyncState).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      status: "failure",
    });
    expect(logger.warn).toHaveBeenCalledWith(
      {
        role: "website-crawler",
        workspaceId: "workspace-1",
        sourceId: "source-1",
        requestedUrl: "https://example.com",
        error: "checkpoint write failed [redacted]",
      },
      "Failed to persist website crawl checkpoint after crawl failure",
    );
  });

  it("publishes unique provider pages through document ingestion", async () => {
    const ingest = vi.fn()
      .mockResolvedValueOnce({ documentId: "doc-1", status: "queued" })
      .mockResolvedValueOnce({ documentId: "doc-2", status: "queued" });
    const service = new WebsiteCrawlerService({
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
      metadata: {
        sourceUrl: "https://example.com/about?utm_source=x",
        canonicalUrl: "https://example.com/about",
      },
    }));
    expect(ingest.mock.calls[0][0].source).toEqual(expect.objectContaining({
      kind: "website",
      url: "https://example.com",
      metadata: expect.objectContaining({
        requestedUrl: "https://example.com",
        provider: "fake",
      }),
    }));
    expect(ingest.mock.calls[1][0]).toEqual(expect.objectContaining({
      title: "https://example.com/contact",
      externalDocumentId: "website:https://example.com:https://example.com/contact",
    }));
    // canonicalUrl is always present so consumers can rely on the key; falls back to sourceUrl when no separate canonical exists.
    expect(ingest.mock.calls[1][0].metadata.canonicalUrl).toBe("https://example.com/contact");
    expect(ingest.mock.calls[1][0].metadata.sourceUrl).toBe("https://example.com/contact");
  });

  it("skips duplicate normalized content within a crawl run", async () => {
    const ingest = vi.fn().mockResolvedValue({ documentId: "doc-1", status: "queued" });
    const service = new WebsiteCrawlerService({
      provider: createProvider([
        {
          sourceUrl: "https://example.com/a",
          canonicalUrl: "https://example.com/a",
          title: "A",
          content: "# Shared",
          metadata: { normalizedContentHash: "hash-1" },
        },
        {
          sourceUrl: "https://example.com/b",
          canonicalUrl: "https://example.com/b",
          title: "B",
          content: "# Shared",
          metadata: { normalizedContentHash: "hash-1" },
        },
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
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.failures).toEqual([{
      sourceUrl: "https://example.com/b",
      reason: "Duplicate normalized content",
    }]);
    expect(ingest).toHaveBeenCalledOnce();
  });

  it("aborts the crawl when document ingestion reports a usage limit", async () => {
    const usageLimitError = Object.assign(new Error("Usage limit exceeded"), {
      statusCode: 429,
      code: "usage_limit_exceeded",
    });
    const ingest = vi.fn()
      .mockResolvedValueOnce({ documentId: "doc-1", status: "queued" })
      .mockRejectedValueOnce(usageLimitError)
      .mockResolvedValue({ documentId: "doc-3", status: "queued" });
    const record = vi.fn();
    const service = new WebsiteCrawlerService({
      provider: createProvider([
        { sourceUrl: "https://example.com/a", title: "A", content: "# A", metadata: {} },
        { sourceUrl: "https://example.com/b", title: "B", content: "# B", metadata: {} },
        { sourceUrl: "https://example.com/c", title: "C", content: "# C", metadata: {} },
      ]),
      documentIngestionService: { ingest },
      auditService: { record },
      assertCrawlUrlAllowed: async () => undefined,
    });

    await expect(
      service.crawlAndPublish({ workspaceId: "workspace-1", url: "https://example.com", limit: 5 }),
    ).rejects.toBe(usageLimitError);

    // The third page must never be attempted once the quota is hit.
    expect(ingest).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "document.website_crawler.crawl", eventStatus: "failure" }),
    );
  });

  it("does not checkpoint a streamed page as processed after a usage limit", async () => {
    const usageLimitError = Object.assign(new Error("Usage limit exceeded"), {
      statusCode: 429,
      code: "usage_limit_exceeded",
    });
    const checkpoints: Array<{
      processingUrls: string[];
      processedCanonicalUrls: string[];
    }> = [];
    const service = new WebsiteCrawlerService({
      provider: {
        name: "stream-crawler",
        crawl: vi.fn(),
        crawlStream: vi.fn(async (request, onPage) => {
          await request.onCheckpointEvent?.({
            type: "discovered",
            url: "https://example.com/quota",
            canonicalUrl: "https://example.com/quota",
          });
          await request.onCheckpointEvent?.({
            type: "processing",
            url: "https://example.com/quota",
            canonicalUrl: "https://example.com/quota",
          });
          await onPage({
            sourceUrl: "https://example.com/quota",
            canonicalUrl: "https://example.com/quota",
            title: "Quota",
            content: "# Quota",
            metadata: {},
          });
          await request.onCheckpointEvent?.({
            type: "processed",
            url: "https://example.com/quota",
            canonicalUrl: "https://example.com/quota",
          });
          return { provider: "stream-crawler", status: "completed" };
        }),
      },
      documentIngestionService: { ingest: vi.fn().mockRejectedValue(usageLimitError) },
      auditService: { record: vi.fn() },
      assertCrawlUrlAllowed: async () => undefined,
    });

    await expect(
      service.crawlAndPublish({
        workspaceId: "workspace-1",
        url: "https://example.com",
        limit: 5,
        onCheckpoint: async (checkpoint) => {
          checkpoints.push({
            processingUrls: checkpoint.processingUrls,
            processedCanonicalUrls: checkpoint.processedCanonicalUrls,
          });
        },
      }),
    ).rejects.toBe(usageLimitError);

    expect(checkpoints.at(-1)).toEqual({
      processingUrls: ["https://example.com/quota"],
      processedCanonicalUrls: [],
    });
  });

  it("keeps a captured usage-limit failure primary when graceful stop checkpoint flush fails", async () => {
    const usageLimitError = Object.assign(new Error("Usage limit exceeded"), {
      statusCode: 429,
      code: "usage_limit_exceeded",
    });
    const checkpointError = new Error("checkpoint write failed token=checkpoint-secret");
    const record = vi.fn();
    const updateSourceSyncState = vi.fn().mockResolvedValue(undefined);
    const logger = { warn: vi.fn() };
    const service = new WebsiteCrawlerService({
      provider: {
        name: "stream-crawler",
        crawl: vi.fn(),
        crawlStream: vi.fn(async (request, onPage) => {
          await request.onCheckpointEvent?.({
            type: "discovered",
            url: "https://example.com/quota",
            canonicalUrl: "https://example.com/quota",
          });
          await request.onCheckpointEvent?.({
            type: "processing",
            url: "https://example.com/quota",
            canonicalUrl: "https://example.com/quota",
          });
          await onPage({
            sourceUrl: "https://example.com/quota",
            canonicalUrl: "https://example.com/quota",
            title: "Quota",
            content: "# Quota",
            metadata: {},
          });
          return { provider: "stream-crawler", status: request.signal?.aborted ? "cancelled" : "completed" };
        }),
      },
      documentIngestionService: {
        ingest: vi.fn().mockRejectedValue(usageLimitError),
        resolveSource: vi.fn().mockResolvedValue({ id: "source-1" }),
        updateSourceSyncState,
      },
      auditService: { record },
      logger,
      assertCrawlUrlAllowed: async () => undefined,
    });

    await expect(service.crawlAndPublish({
      workspaceId: "workspace-1",
      url: "https://example.com",
      limit: 1,
      onCheckpoint: async () => { throw checkpointError; },
    })).rejects.toBe(usageLimitError);

    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "document.website_crawler.crawl",
      eventStatus: "failure",
    }));
    expect(updateSourceSyncState).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      status: "failure",
    });
    expect(logger.warn).toHaveBeenCalledWith(
      {
        role: "website-crawler",
        workspaceId: "workspace-1",
        sourceId: "source-1",
        requestedUrl: "https://example.com",
        error: "checkpoint write failed [redacted]",
      },
      "Failed to persist website crawl checkpoint after crawl failure",
    );
  });

  it("uses stable external document IDs for repeated crawls", async () => {
    const ingest = vi.fn().mockResolvedValue({ documentId: "doc-1", status: "queued" });
    const service = new WebsiteCrawlerService({
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

  it("resolves one website source and publishes pages under it across repeated crawls", async () => {
    const ingest = vi.fn().mockResolvedValue({ documentId: "doc-1", status: "queued" });
    const resolveSource = vi.fn().mockResolvedValue({ id: "source-1" });
    const updateSourceSyncState = vi.fn().mockResolvedValue(undefined);
    const service = new WebsiteCrawlerService({
      provider: createProvider([
        {
          sourceUrl: "https://example.com/about",
          title: "About",
          content: "# About",
          metadata: {},
        },
      ]),
      documentIngestionService: { ingest, resolveSource, updateSourceSyncState },
      auditService: { record: vi.fn() },
      assertCrawlUrlAllowed: async () => undefined,
    });

    await service.crawlAndPublish({ workspaceId: "workspace-1", url: "https://example.com/docs/", limit: 1 });
    await service.crawlAndPublish({ workspaceId: "workspace-1", url: "https://example.com/docs", limit: 1 });

    expect(resolveSource).toHaveBeenCalledTimes(2);
    expect(resolveSource.mock.calls[0][0]).toMatchObject({
      workspaceId: "workspace-1",
      source: {
        kind: "website",
        url: "https://example.com/docs",
        config: {
          url: "https://example.com/docs",
          limit: 1,
        },
      },
    });
    expect(ingest.mock.calls.every((call) => call[0].source.id === "source-1")).toBe(true);
    expect(updateSourceSyncState).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      status: "success",
      syncedAt: expect.any(Date),
    }));
  });

  it("reports page publication failures without leaking provider metadata", async () => {
    const ingest = vi.fn()
      .mockResolvedValueOnce({ documentId: "doc-1", status: "queued" })
      .mockRejectedValueOnce(new Error("database unavailable"));
    const service = new WebsiteCrawlerService({
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
    const service = new WebsiteCrawlerService({
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
      eventType: "document.website_crawler.crawl",
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
    const service = new WebsiteCrawlerService({
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
      eventType: "document.website_crawler.crawl",
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
    const service = new WebsiteCrawlerService({
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
    const service = new WebsiteCrawlerService({
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

  it("rejects allow-listed metadata values that are not the expected primitive type", async () => {
    const ingest = vi.fn().mockResolvedValue({ documentId: "doc-1", status: "queued" });
    const service = new WebsiteCrawlerService({
      provider: createProvider([
        {
          sourceUrl: "https://example.com/a",
          canonicalUrl: "https://example.com/a",
          title: "A",
          content: "A",
          metadata: {
            // Wrong types or hostile shapes for the three allow-listed keys
            httpStatus: { __proto__: { polluted: true }, nested: "uh oh" },
            etag: ["array", "instead"],
            lastModified: { hostile: { deeply: { nested: "value" } } },
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

    expect(ingest.mock.calls[0][0].metadata).toEqual({
      sourceUrl: "https://example.com/a",
      canonicalUrl: "https://example.com/a",
    });
  });

  it("rejects allow-listed string fields that exceed the safe length cap", async () => {
    const ingest = vi.fn().mockResolvedValue({ documentId: "doc-1", status: "queued" });
    const huge = "x".repeat(2048);
    const service = new WebsiteCrawlerService({
      provider: createProvider([
        {
          sourceUrl: "https://example.com/a",
          canonicalUrl: "https://example.com/a",
          title: "A",
          content: "A",
          metadata: { etag: huge, lastModified: huge, httpStatus: 200 },
        },
      ]),
      documentIngestionService: { ingest },
      auditService: { record: vi.fn() },
      assertCrawlUrlAllowed: async () => undefined,
    });

    await service.crawlAndPublish({ workspaceId: "workspace-1", url: "https://example.com", limit: 1 });

    expect(ingest.mock.calls[0][0].metadata).toEqual({
      sourceUrl: "https://example.com/a",
      canonicalUrl: "https://example.com/a",
      httpStatus: 200,
    });
  });

  it("ignores provider-supplied metadata fields outside the allow-list, including spoofed source identifiers and secrets", async () => {
    const ingest = vi.fn().mockResolvedValue({ documentId: "doc-1", status: "queued" });
    const service = new WebsiteCrawlerService({
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
            httpStatus: 200,
            etag: "abc-etag",
            lastModified: "Mon, 01 Jan 2026 00:00:00 GMT",
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

    const metadata = ingest.mock.calls[0][0].metadata as Record<string, unknown>;
    expect(metadata).toEqual({
      sourceUrl: "https://example.com/a",
      canonicalUrl: "https://example.com/a", // always present; falls back to sourceUrl when no separate canonical exists.
      httpStatus: 200,
      etag: "abc-etag",
      lastModified: "Mon, 01 Jan 2026 00:00:00 GMT",
    });
    expect(metadata.sourceKind).toBeUndefined();
    expect(metadata.websiteBaseUrl).toBeUndefined();
    expect(metadata.websiteCrawlerProvider).toBeUndefined();
    expect(metadata.safeField).toBeUndefined();
    expect(JSON.stringify(metadata)).not.toContain("crawler-secret");
    expect(JSON.stringify(metadata)).not.toContain("attacker.example");
  });

  it("redacts provider-controlled identifiers in responses, audits, and metadata", async () => {
    const ingest = vi.fn().mockResolvedValue({ documentId: "doc-1", status: "queued" });
    const auditService = { record: vi.fn() };
    const service = new WebsiteCrawlerService({
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
    const service = new WebsiteCrawlerService({
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
    expect(ingest.mock.calls[0][0].metadata).toEqual({
      sourceUrl: "https://example.com/page?token=%5Bredacted%5D&signature=%5Bredacted%5D&topic=docs",
      canonicalUrl: "https://example.com/page?apiKey=%5Bredacted%5D&sig=%5Bredacted%5D&topic=docs",
    });
    // Source-level identifiers (websiteBaseUrl, provider) live on the source row, not per-document.
    expect(ingest.mock.calls[0][0].source.metadata).toEqual(expect.objectContaining({
      requestedUrl: "https://example.com/search?apiKey=%5Bredacted%5D&q=docs",
    }));
  });

  it("preserves crawl request query strings when calling the provider", async () => {
    const crawl = vi.fn().mockResolvedValue({
      provider: "custom-crawler",
      pages: [],
    });
    const service = new WebsiteCrawlerService({
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

    expect(crawl).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://example.com/search?q=api",
      limit: 1,
    }));
    expect(result.requestedUrl).toBe("https://example.com/search?q=api");
  });

  it("passes only the remaining page limit when resuming from a checkpoint", async () => {
    const crawl = vi.fn().mockResolvedValue({
      provider: "custom-crawler",
      pages: [],
    });
    const service = new WebsiteCrawlerService({
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
      limit: 100,
      checkpoint: {
        discoveredUrls: [],
        queuedUrls: [],
        processingUrls: [],
        processedCanonicalUrls: [],
        accepted: 80,
        skipped: 5,
        failed: 3,
        lastProcessedAt: null,
      },
    });

    expect(crawl).toHaveBeenCalledWith(expect.objectContaining({
      limit: 12,
    }));
  });

  it("does not call the provider when a resumed checkpoint already reached the page limit", async () => {
    const crawl = vi.fn();
    const service = new WebsiteCrawlerService({
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
      url: "https://example.com",
      limit: 100,
      checkpoint: {
        discoveredUrls: [],
        queuedUrls: [],
        processingUrls: [],
        processedCanonicalUrls: [],
        accepted: 80,
        skipped: 15,
        failed: 5,
        lastProcessedAt: null,
      },
    });

    expect(crawl).not.toHaveBeenCalled();
    expect(result.accepted).toBe(80);
    expect(result.skipped).toBe(15);
    expect(result.failed).toBe(5);
    expect(result.status).toBe("completed");
  });

  it("returns a yielded slice without publishing terminal source or audit state", async () => {
    const auditService = { record: vi.fn() };
    const updateSourceSyncState = vi.fn();
    const service = new WebsiteCrawlerService({
      provider: {
        name: "stream-crawler",
        crawl: vi.fn(),
        crawlStream: vi.fn().mockResolvedValue({
          provider: "stream-crawler",
          outcome: "yielded",
        }),
      },
      documentIngestionService: {
        ingest: vi.fn(),
        resolveSource: vi.fn().mockResolvedValue({ id: "source-1" }),
        updateSourceSyncState,
      },
      auditService,
      assertCrawlUrlAllowed: async () => undefined,
    });

    const result = await service.crawlAndPublish({
      workspaceId: "workspace-1",
      url: "https://example.com",
      limit: 100,
      maxDurationMs: 240_000,
    });

    expect(result.outcome).toBe("yielded");
    expect(updateSourceSyncState).not.toHaveBeenCalled();
    expect(auditService.record).not.toHaveBeenCalled();
  });

  it("passes request cancellation signals into the abstract provider", async () => {
    const controller = new AbortController();
    const crawl = vi.fn().mockResolvedValue({
      provider: "custom-crawler",
      pages: [],
    });
    const service = new WebsiteCrawlerService({
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
      signal: controller.signal,
    });

    expect(crawl).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://example.com",
      limit: 1,
      signal: expect.any(AbortSignal),
    }));
    // The crawl runs under a derived signal (so a mid-crawl quota stop can abort
    // it), but request cancellation must still propagate to the provider.
    const forwardedSignal = crawl.mock.calls[0][0].signal as AbortSignal;
    expect(forwardedSignal.aborted).toBe(false);
    controller.abort();
    expect(forwardedSignal.aborted).toBe(true);
  });

  it("stops before provider calls when the request signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const crawl = vi.fn();
    const service = new WebsiteCrawlerService({
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
    const service = new WebsiteCrawlerService({
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
    const service = new WebsiteCrawlerService({
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

  it("counts crawler transport failures as failed pages before empty-content skips", async () => {
    const ingest = vi.fn();
    const resolveSource = vi.fn().mockResolvedValue({ id: "source-1" });
    const updateSourceSyncState = vi.fn().mockResolvedValue(undefined);
    const service = new WebsiteCrawlerService({
      provider: createProvider([
        {
          sourceUrl: "https://example.com/blocked",
          title: null,
          content: "",
          metadata: {
            crawlerStatus: "failed",
            error: "Blocked by status code 403 token=crawler-secret",
            httpStatus: 403,
          },
        },
      ]),
      documentIngestionService: { ingest, resolveSource, updateSourceSyncState },
      auditService: { record: vi.fn() },
      assertCrawlUrlAllowed: async () => undefined,
    });

    const result = await service.crawlAndPublish({
      workspaceId: "workspace-1",
      url: "https://example.com",
      limit: 1,
    });

    expect(result.accepted).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.failures).toEqual([{
      sourceUrl: "https://example.com/blocked",
      reason: "Crawler failed: Blocked by status code 403 [redacted]",
    }]);
    expect(ingest).not.toHaveBeenCalled();
    expect(updateSourceSyncState).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      status: "failure",
    }));
  });

  it("enforces local page limits and accounts for malformed provider page URLs", async () => {
    const ingest = vi.fn().mockResolvedValue({ documentId: "doc-1", status: "queued" });
    const service = new WebsiteCrawlerService({
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

  it("reaps missing pages after a fresh, fully successful crawl", async () => {
    const ingest = vi.fn().mockResolvedValueOnce({ documentId: "doc-1", status: "queued" });
    const resolveSource = vi.fn().mockResolvedValue({ id: "source-1" });
    const updateSourceSyncState = vi.fn().mockResolvedValue(undefined);
    const reapMissingPages = vi.fn().mockResolvedValue({ deletedCount: 2, deletedContentBytes: 8 });

    const service = new WebsiteCrawlerService({
      provider: createProvider([
        {
          sourceUrl: "https://example.com/a",
          canonicalUrl: "https://example.com/a",
          title: "A",
          content: "alpha",
          metadata: { statusCode: 200 },
        },
      ]),
      documentIngestionService: { ingest, resolveSource, updateSourceSyncState, reapMissingPages },
      auditService: { record: vi.fn() },
      assertCrawlUrlAllowed: async () => undefined,
    });

    await service.crawlAndPublish({
      workspaceId: "workspace-1",
      url: "https://example.com",
      limit: 5,
    });

    expect(reapMissingPages).toHaveBeenCalledTimes(1);
    expect(reapMissingPages).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      keepExternalDocumentIds: ["website:https://example.com:https://example.com/a"],
    });
  });

  it("logs but does not fail when best-effort reaping fails", async () => {
    const ingest = vi.fn().mockResolvedValueOnce({ documentId: "doc-1", status: "queued" });
    const resolveSource = vi.fn().mockResolvedValue({ id: "source-1" });
    const updateSourceSyncState = vi.fn().mockResolvedValue(undefined);
    const reapMissingPages = vi.fn().mockRejectedValue(new Error("delete failed"));
    const logger = { warn: vi.fn() };

    const service = new WebsiteCrawlerService({
      provider: createProvider([
        {
          sourceUrl: "https://example.com/a",
          canonicalUrl: "https://example.com/a",
          title: "A",
          content: "alpha",
          metadata: { statusCode: 200 },
        },
      ]),
      documentIngestionService: { ingest, resolveSource, updateSourceSyncState, reapMissingPages },
      auditService: { record: vi.fn() },
      logger,
      assertCrawlUrlAllowed: async () => undefined,
    });

    const result = await service.crawlAndPublish({
      workspaceId: "workspace-1",
      url: "https://example.com",
      limit: 5,
    });

    expect(result.accepted).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "website-crawler",
        workspaceId: "workspace-1",
        sourceId: "source-1",
        error: "delete failed",
      }),
      "Failed to reap missing website pages after crawl",
    );
  });

  it("skips reaping when a successful crawl may have stopped at the page limit", async () => {
    const ingest = vi.fn().mockResolvedValueOnce({ documentId: "doc-1", status: "queued" });
    const resolveSource = vi.fn().mockResolvedValue({ id: "source-1" });
    const updateSourceSyncState = vi.fn().mockResolvedValue(undefined);
    const reapMissingPages = vi.fn();

    const service = new WebsiteCrawlerService({
      provider: createProvider([
        {
          sourceUrl: "https://example.com/a",
          canonicalUrl: "https://example.com/a",
          title: "A",
          content: "alpha",
          metadata: { statusCode: 200 },
        },
      ]),
      documentIngestionService: { ingest, resolveSource, updateSourceSyncState, reapMissingPages },
      auditService: { record: vi.fn() },
      assertCrawlUrlAllowed: async () => undefined,
    });

    await service.crawlAndPublish({
      workspaceId: "workspace-1",
      url: "https://example.com",
      limit: 1,
    });

    expect(reapMissingPages).not.toHaveBeenCalled();
  });

  it("skips reaping when the crawl resumed from a checkpoint", async () => {
    const ingest = vi.fn().mockResolvedValueOnce({ documentId: "doc-1", status: "queued" });
    const resolveSource = vi.fn().mockResolvedValue({ id: "source-2" });
    const updateSourceSyncState = vi.fn().mockResolvedValue(undefined);
    const reapMissingPages = vi.fn();

    const service = new WebsiteCrawlerService({
      provider: createProvider([
        {
          sourceUrl: "https://example.com/a",
          canonicalUrl: "https://example.com/a",
          title: "A",
          content: "alpha",
          metadata: { statusCode: 200 },
        },
      ]),
      documentIngestionService: { ingest, resolveSource, updateSourceSyncState, reapMissingPages },
      auditService: { record: vi.fn() },
      assertCrawlUrlAllowed: async () => undefined,
    });

    await service.crawlAndPublish({
      workspaceId: "workspace-1",
      url: "https://example.com",
      limit: 5,
      checkpoint: {
        discoveredUrls: ["https://example.com/old"],
        queuedUrls: [],
        processingUrls: [],
        processedCanonicalUrls: ["https://example.com/old"],
        processedContentHashes: [],
        accepted: 1,
        skipped: 0,
        failed: 0,
        lastProcessedAt: null,
      },
    });

    expect(reapMissingPages).not.toHaveBeenCalled();
  });

  it("skips reaping when the crawl had failures", async () => {
    const ingest = vi.fn().mockResolvedValueOnce({ documentId: "doc-1", status: "queued" });
    const resolveSource = vi.fn().mockResolvedValue({ id: "source-3" });
    const updateSourceSyncState = vi.fn().mockResolvedValue(undefined);
    const reapMissingPages = vi.fn();

    const service = new WebsiteCrawlerService({
      provider: createProvider([
        {
          sourceUrl: "https://example.com/a",
          canonicalUrl: "https://example.com/a",
          title: "A",
          content: "alpha",
          metadata: { statusCode: 200 },
        },
        {
          sourceUrl: "not-a-url",
          canonicalUrl: "not-a-url",
          title: "Broken",
          content: "boom",
          metadata: { statusCode: 200 },
        },
      ]),
      documentIngestionService: { ingest, resolveSource, updateSourceSyncState, reapMissingPages },
      auditService: { record: vi.fn() },
      assertCrawlUrlAllowed: async () => undefined,
    });

    await service.crawlAndPublish({
      workspaceId: "workspace-1",
      url: "https://example.com",
      limit: 5,
    });

    expect(reapMissingPages).not.toHaveBeenCalled();
  });
});
