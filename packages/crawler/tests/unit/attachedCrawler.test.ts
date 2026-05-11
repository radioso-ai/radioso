import { createHash } from "crypto";
import { describe, expect, it, vi } from "vitest";
import { runAttachedCrawler } from "../../src/core/runCrawler.js";
import type { CrawlerPersistence } from "../../src/persistence/ports.js";
import type {
  CrawlerFrontierRecord,
  CrawlerPageRecord,
  CrawlerSourceRecord,
  PersistedCrawlerRunRecord,
  PublicationAttemptRecord
} from "../../src/persistence/types.js";
import type { DocumentPublisher } from "../../src/types.js";

const createFakePersistence = (): CrawlerPersistence & {
  state: {
    frontier: CrawlerFrontierRecord[];
    pages: CrawlerPageRecord[];
    publicationAttempts: PublicationAttemptRecord[];
    runs: PersistedCrawlerRunRecord[];
    sources: CrawlerSourceRecord[];
  };
} => {
  const state = {
    frontier: [] as CrawlerFrontierRecord[],
    pages: [] as CrawlerPageRecord[],
    publicationAttempts: [] as PublicationAttemptRecord[],
    runs: [] as PersistedCrawlerRunRecord[],
    sources: [] as CrawlerSourceRecord[]
  };
  let nextId = 1;
  const newId = () => `id_${nextId++}`;
  const now = "2025-01-01T00:00:00.000Z";

  return {
    state,
    sources: {
      create: async (input) => {
        const record: CrawlerSourceRecord = {
          id: newId(),
          scopeKey: input.scopeKey,
          baseUrl: input.baseUrl,
          displayName: input.displayName ?? null,
          mode: input.mode,
          status: input.status ?? "active",
          createdAt: now,
          updatedAt: now
        };
        state.sources.push(record);
        return record;
      },
      getById: async (id) => state.sources.find((source) => source.id === id) ?? null,
      getByScopeKey: async (scopeKey) =>
        state.sources.find((source) => source.scopeKey === scopeKey) ?? null,
      updateStatus: async ({ id, status }) => {
        const existing = state.sources.find((source) => source.id === id) ?? null;
        if (!existing) {
          return null;
        }
        existing.status = status;
        existing.updatedAt = now;
        return existing;
      }
    },
    runs: {
      create: async (input) => {
        const record: PersistedCrawlerRunRecord = {
          id: newId(),
          sourceId: input.sourceId,
          mode: input.mode,
          status: input.status ?? "queued",
          statusReason: input.statusReason ?? null,
          pageLimit: input.pageLimit,
          speedProfile: input.speedProfile ?? "balanced",
          transportModeRequested: input.transportModeRequested ?? "hybrid",
          transportModeEffective: input.transportModeEffective ?? input.transportModeRequested ?? "hybrid",
          pagesDiscovered: 0,
          pagesCrawled: 0,
          pagesFailed: 0,
          pagesUnchanged: 0,
          pagesPublished: 0,
          publicationFailures: 0,
          httpPagesAttempted: 0,
          httpPagesAccepted: 0,
          browserPagesAttempted: 0,
          browserFallbackCount: 0,
          runStartedAt: input.runStartedAt ?? null,
          finishedAt: input.finishedAt ?? null,
          createdAt: now
        };
        state.runs.push(record);
        return record;
      },
      getById: async (id) => state.runs.find((run) => run.id === id) ?? null,
      listBySourceId: async (sourceId) => state.runs.filter((run) => run.sourceId === sourceId),
      update: async (input) => {
        const run = state.runs.find((record) => record.id === input.id);
        if (!run) {
          return;
        }
        if (input.status !== undefined) run.status = input.status;
        if (input.statusReason !== undefined) run.statusReason = input.statusReason;
        if (input.pagesDiscovered !== undefined) run.pagesDiscovered = input.pagesDiscovered;
        if (input.pagesCrawled !== undefined) run.pagesCrawled = input.pagesCrawled;
        if (input.pagesFailed !== undefined) run.pagesFailed = input.pagesFailed;
        if (input.pagesUnchanged !== undefined) run.pagesUnchanged = input.pagesUnchanged;
        if (input.pagesPublished !== undefined) run.pagesPublished = input.pagesPublished;
        if (input.publicationFailures !== undefined) {
          run.publicationFailures = input.publicationFailures;
        }
        if (input.httpPagesAttempted !== undefined) run.httpPagesAttempted = input.httpPagesAttempted;
        if (input.httpPagesAccepted !== undefined) run.httpPagesAccepted = input.httpPagesAccepted;
        if (input.browserPagesAttempted !== undefined) {
          run.browserPagesAttempted = input.browserPagesAttempted;
        }
        if (input.browserFallbackCount !== undefined) {
          run.browserFallbackCount = input.browserFallbackCount;
        }
        if (input.runStartedAt !== undefined) run.runStartedAt = input.runStartedAt;
        if (input.finishedAt !== undefined) run.finishedAt = input.finishedAt;
        if (input.transportModeEffective !== undefined) {
          run.transportModeEffective = input.transportModeEffective;
        }
      }
    },
    frontier: {
      ensureQueued: async (input) => {
        const existing =
          state.frontier.find((item) => item.runId === input.runId && item.url === input.url) ?? null;
        if (existing) {
          return { created: false, item: existing };
        }
        const record: CrawlerFrontierRecord = {
          id: newId(),
          runId: input.runId,
          url: input.url,
          canonicalUrl: input.canonicalUrl ?? null,
          status: "queued",
          attemptCount: 0,
          maxAttempts: input.maxAttempts ?? 3,
          lastError: null,
          firstDiscoveredAt: now,
          lastUpdatedAt: now,
          completedAt: null
        };
        state.frontier.push(record);
        return { created: true, item: record };
      },
      listByRunId: async (runId) => state.frontier.filter((item) => item.runId === runId),
      markStatus: async ({ runId, url, status, lastError = null }) => {
        const item = state.frontier.find((record) => record.runId === runId && record.url === url);
        if (!item) {
          return;
        }
        item.status = status;
        item.lastError = lastError;
        item.lastUpdatedAt = now;
        if (status === "processing") {
          item.attemptCount += 1;
        }
        if (status === "succeeded" || status === "failed_terminal") {
          item.completedAt = now;
        }
      }
    },
    pages: {
      upsert: async (input) => {
        const existing =
          state.pages.find(
            (page) =>
              page.sourceId === input.sourceId &&
              page.canonicalUrlKey === input.canonicalUrlKey
          ) ?? null;
        if (existing) {
          Object.assign(existing, {
            runId: input.runId,
            frontierUrl: input.frontierUrl,
            fetchedUrl: input.fetchedUrl,
            canonicalUrl: input.canonicalUrl,
            canonicalUrlKey: input.canonicalUrlKey,
            title: input.title,
            content: input.content,
            contentHash: input.contentHash,
            status: input.status,
            httpStatus: input.httpStatus,
            etag: input.etag ?? null,
            lastModified: input.lastModified ?? null,
            transportUsed: input.transportUsed ?? null,
            browserFallbackReason: input.browserFallbackReason ?? null,
            httpQualityScore: input.httpQualityScore ?? null,
            error: input.error ?? null,
            lastFetchedAt: input.lastFetchedAt ?? now,
            updatedAt: now
          });
          return existing;
        }

        const record: CrawlerPageRecord = {
          id: newId(),
          sourceId: input.sourceId,
          runId: input.runId,
          frontierUrl: input.frontierUrl,
          fetchedUrl: input.fetchedUrl,
          canonicalUrl: input.canonicalUrl,
          canonicalUrlKey: input.canonicalUrlKey,
          title: input.title,
          content: input.content,
          contentHash: input.contentHash,
          status: input.status,
          httpStatus: input.httpStatus,
          etag: input.etag ?? null,
          lastModified: input.lastModified ?? null,
          transportUsed: input.transportUsed ?? null,
          browserFallbackReason: input.browserFallbackReason ?? null,
          httpQualityScore: input.httpQualityScore ?? null,
          error: input.error ?? null,
          lastFetchedAt: input.lastFetchedAt ?? now,
          createdAt: now,
          updatedAt: now
        };
        state.pages.push(record);
        return record;
      },
      getByCanonicalUrlKey: async (sourceId, canonicalUrlKey) =>
        state.pages.find(
          (page) => page.sourceId === sourceId && page.canonicalUrlKey === canonicalUrlKey
        ) ?? null,
      listBySourceId: async (sourceId) =>
        state.pages.filter((page) => page.sourceId === sourceId),
      listByRunId: async (runId) => state.pages.filter((page) => page.runId === runId)
    },
    publicationAttempts: {
      create: async (input) => {
        const record: PublicationAttemptRecord = {
          id: newId(),
          pageRecordId: input.pageRecordId,
          externalId: input.externalId,
          operation: input.operation,
          status: input.status,
          publisherKind: input.publisherKind,
          responseDocumentId: input.responseDocumentId ?? null,
          responseStatus: input.responseStatus ?? null,
          failureCode: input.failureCode ?? null,
          failureMessage: input.failureMessage ?? null,
          attemptedAt: now,
          completedAt: input.completedAt ?? null
        };
        state.publicationAttempts.push(record);
        return record;
      },
      listByPageRecordId: async (pageRecordId) =>
        state.publicationAttempts.filter((attempt) => attempt.pageRecordId === pageRecordId)
    }
  };
};

describe("runAttachedCrawler", () => {
  it("publishes successful pages through the document publisher and crawler-owned state", async () => {
    const persistence = createFakePersistence();
    const publisher: DocumentPublisher = {
      upsert: vi.fn(async (document) => ({
        documentId: document.externalId,
        status: "processed"
      })),
      remove: vi.fn(async () => undefined)
    };

    const result = await runAttachedCrawler({
      persistence,
      documentPublisher: publisher,
      source: {
        scopeKey: "acct_123:example.com:/docs",
        baseUrl: "https://example.com/docs"
      },
      pageLimit: 1,
      fetchPage: async () => ({
        url: "https://example.com/docs",
        title: "Docs Home",
        text: "hello crawler",
        html: "<html></html>",
        httpStatus: 200,
        links: [],
        transportUsed: "http",
        httpAttempted: true
      })
    });

    expect(result.stats).toEqual(
      expect.objectContaining({
        pagesDiscovered: 1,
        pagesCrawled: 1,
        pagesPublished: 1,
        pagesFailed: 0,
        publicationFailures: 0,
        httpPagesAttempted: 1,
        httpPagesAccepted: 1
      })
    );
    expect(publisher.upsert).toHaveBeenCalledTimes(1);
    expect(persistence.state.pages).toHaveLength(1);
    expect(persistence.state.publicationAttempts).toEqual([
      expect.objectContaining({
        externalId: "acct_123:example.com:/docs:https://example.com/docs",
        status: "delivered"
      })
    ]);
    expect(result.run.status).toBe("completed");
  });

  it("skips duplicate document publication for unchanged pages", async () => {
    const persistence = createFakePersistence();
    const content = "hello crawler";
    const contentHash = createHash("sha256").update(content).digest("hex");
    const source = await persistence.sources.create({
      scopeKey: "acct_123:example.com:/docs",
      baseUrl: "https://example.com/docs",
      mode: "attached"
    });
    await persistence.pages.upsert({
      sourceId: source.id,
      runId: "old_run",
      frontierUrl: "https://example.com/docs",
      fetchedUrl: "https://example.com/docs",
      canonicalUrl: "https://example.com/docs",
      canonicalUrlKey: "https://example.com/docs",
      title: "Docs Home",
      content,
      contentHash,
      status: "success",
      httpStatus: 200
    });

    const publisher: DocumentPublisher = {
      upsert: vi.fn(async (document) => ({
        documentId: document.externalId,
        status: "processed"
      })),
      remove: vi.fn(async () => undefined)
    };

    const result = await runAttachedCrawler({
      persistence,
      documentPublisher: publisher,
      source: {
        scopeKey: source.scopeKey,
        baseUrl: source.baseUrl
      },
      pageLimit: 1,
      fetchPage: async () => ({
        url: "https://example.com/docs",
        title: "Docs Home",
        text: content,
        html: "<html></html>",
        httpStatus: 200,
        links: [],
        transportUsed: "http",
        httpAttempted: true
      })
    });

    expect(result.stats.pagesUnchanged).toBe(1);
    expect(result.stats.pagesPublished).toBe(0);
    expect(publisher.upsert).not.toHaveBeenCalled();
    expect(persistence.state.publicationAttempts).toHaveLength(0);
  });

  it("records retryable publication failures without failing the crawl run", async () => {
    const persistence = createFakePersistence();
    const publisher: DocumentPublisher = {
      upsert: vi.fn(async () => {
        throw new Error("temporary host failure");
      }),
      remove: vi.fn(async () => undefined)
    };

    const result = await runAttachedCrawler({
      persistence,
      documentPublisher: publisher,
      source: {
        scopeKey: "acct_123:example.com:/docs",
        baseUrl: "https://example.com/docs"
      },
      pageLimit: 1,
      fetchPage: async () => ({
        url: "https://example.com/docs",
        title: "Docs Home",
        text: "hello crawler",
        html: "<html></html>",
        httpStatus: 200,
        links: []
      })
    });

    expect(result.run.status).toBe("completed");
    expect(result.run.statusReason).toBe("publication_pending");
    expect(result.stats.publicationFailures).toBe(1);
    expect(persistence.state.publicationAttempts).toHaveLength(2);
    expect(persistence.state.publicationAttempts[0]).toEqual(
      expect.objectContaining({
        status: "retryable",
        failureMessage: "temporary host failure"
      })
    );
    expect(persistence.state.publicationAttempts[1]).toEqual(
      expect.objectContaining({
        status: "retryable",
        failureMessage: "temporary host failure"
      })
    );
  });

  it("retries publication failures within the same run before marking the run complete", async () => {
    const persistence = createFakePersistence();
    const publisher: DocumentPublisher = {
      upsert: vi
        .fn()
        .mockRejectedValueOnce(new Error("temporary host failure"))
        .mockResolvedValueOnce({
          documentId: "doc_1",
          status: "processed"
        }),
      remove: vi.fn(async () => undefined)
    };

    const result = await runAttachedCrawler({
      persistence,
      documentPublisher: publisher,
      source: {
        scopeKey: "acct_123:example.com:/docs",
        baseUrl: "https://example.com/docs"
      },
      pageLimit: 1,
      fetchPage: async () => ({
        url: "https://example.com/docs",
        title: "Docs Home",
        text: "hello crawler",
        html: "<html></html>",
        httpStatus: 200,
        links: []
      })
    });

    expect(publisher.upsert).toHaveBeenCalledTimes(2);
    expect(result.run.status).toBe("completed");
    expect(result.run.statusReason).toBeNull();
    expect(result.stats.pagesPublished).toBe(1);
    expect(result.stats.publicationFailures).toBe(0);
    expect(persistence.state.publicationAttempts).toEqual([
      expect.objectContaining({
        operation: "upsert",
        status: "retryable"
      }),
      expect.objectContaining({
        operation: "upsert",
        status: "delivered"
      })
    ]);
  });

  it("resumes an interrupted attached crawl from crawler-owned frontier state", async () => {
    const persistence = createFakePersistence();
    const source = await persistence.sources.create({
      scopeKey: "acct_123:example.com:/docs",
      baseUrl: "https://example.com/docs",
      mode: "attached"
    });
    const run = await persistence.runs.create({
      sourceId: source.id,
      mode: "attached",
      pageLimit: 2,
      status: "running",
      runStartedAt: "2025-01-01T00:00:00.000Z"
    });

    await persistence.frontier.ensureQueued({
      runId: run.id,
      url: "https://example.com/docs"
    });
    await persistence.frontier.markStatus({
      runId: run.id,
      url: "https://example.com/docs",
      status: "succeeded"
    });
    await persistence.frontier.ensureQueued({
      runId: run.id,
      url: "https://example.com/docs/advanced"
    });
    await persistence.frontier.markStatus({
      runId: run.id,
      url: "https://example.com/docs/advanced",
      status: "processing"
    });
    await persistence.runs.update({
      id: run.id,
      pagesDiscovered: 2,
      pagesCrawled: 1
    });

    const publisher: DocumentPublisher = {
      upsert: vi.fn(async (document) => ({
        documentId: document.externalId,
        status: "processed"
      })),
      remove: vi.fn(async () => undefined)
    };

    const result = await runAttachedCrawler({
      persistence,
      documentPublisher: publisher,
      source: {
        scopeKey: source.scopeKey,
        baseUrl: source.baseUrl
      },
      pageLimit: 2,
      fetchPage: async (url) => ({
        url,
        title: "Advanced",
        text: "recovered page",
        html: "<html></html>",
        httpStatus: 200,
        links: []
      })
    });

    expect(result.run.id).toBe(run.id);
    expect(result.run.status).toBe("completed");
    expect(result.run.statusReason).toBeNull();
    expect(result.stats.pagesDiscovered).toBe(2);
    expect(result.stats.pagesCrawled).toBe(2);
    expect(persistence.state.runs).toHaveLength(1);
    expect(
      persistence.state.frontier.find((item) => item.url === "https://example.com/docs/advanced")
    ).toEqual(
      expect.objectContaining({
        status: "succeeded",
        attemptCount: 2
      })
    );
  });

  it("retries pending publication attempts after a later unchanged recrawl", async () => {
    const persistence = createFakePersistence();
    const source = await persistence.sources.create({
      scopeKey: "acct_123:example.com:/docs",
      baseUrl: "https://example.com/docs",
      mode: "attached"
    });
    const previousRun = await persistence.runs.create({
      sourceId: source.id,
      mode: "attached",
      pageLimit: 1,
      status: "completed",
      statusReason: "publication_pending",
      runStartedAt: "2025-01-01T00:00:00.000Z",
      finishedAt: "2025-01-01T00:01:00.000Z"
    });
    const content = "hello crawler";
    const page = await persistence.pages.upsert({
      sourceId: source.id,
      runId: previousRun.id,
      frontierUrl: "https://example.com/docs",
      fetchedUrl: "https://example.com/docs",
      canonicalUrl: "https://example.com/docs",
      canonicalUrlKey: "https://example.com/docs",
      title: "Docs Home",
      content,
      contentHash: createHash("sha256").update(content).digest("hex"),
      status: "success",
      httpStatus: 200
    });
    await persistence.publicationAttempts.create({
      pageRecordId: page.id,
      externalId: "acct_123:example.com:/docs:https://example.com/docs",
      operation: "upsert",
      status: "retryable",
      publisherKind: "in_process",
      failureMessage: "temporary host failure",
      completedAt: "2025-01-01T00:01:00.000Z"
    });

    const publisher: DocumentPublisher = {
      upsert: vi.fn(async (document) => ({
        documentId: document.externalId,
        status: "processed"
      })),
      remove: vi.fn(async () => undefined)
    };

    const result = await runAttachedCrawler({
      persistence,
      documentPublisher: publisher,
      source: {
        scopeKey: source.scopeKey,
        baseUrl: source.baseUrl
      },
      pageLimit: 1,
      fetchPage: async () => ({
        url: "https://example.com/docs",
        title: "Docs Home",
        text: content,
        html: "<html></html>",
        httpStatus: 200,
        links: []
      })
    });

    expect(result.stats.pagesUnchanged).toBe(1);
    expect(result.stats.pagesPublished).toBe(1);
    expect(result.stats.publicationFailures).toBe(0);
    expect(publisher.upsert).toHaveBeenCalledTimes(1);
    expect(persistence.state.publicationAttempts).toHaveLength(2);
    expect(persistence.state.publicationAttempts[1]).toEqual(
      expect.objectContaining({
        status: "delivered"
      })
    );
  });

  it("clears stale delete retries when a page is observed alive again as unchanged", async () => {
    const persistence = createFakePersistence();
    const source = await persistence.sources.create({
      scopeKey: "acct_123:example.com:/docs",
      baseUrl: "https://example.com/docs",
      mode: "attached"
    });
    const previousRun = await persistence.runs.create({
      sourceId: source.id,
      mode: "attached",
      pageLimit: 1,
      status: "completed",
      statusReason: "publication_pending",
      runStartedAt: "2025-01-01T00:00:00.000Z",
      finishedAt: "2025-01-01T00:01:00.000Z"
    });
    const content = "hello crawler";
    const page = await persistence.pages.upsert({
      sourceId: source.id,
      runId: previousRun.id,
      frontierUrl: "https://example.com/docs",
      fetchedUrl: "https://example.com/docs",
      canonicalUrl: "https://example.com/docs",
      canonicalUrlKey: "https://example.com/docs",
      title: "Docs Home",
      content,
      contentHash: createHash("sha256").update(content).digest("hex"),
      status: "success",
      httpStatus: 200
    });
    await persistence.publicationAttempts.create({
      pageRecordId: page.id,
      externalId: "acct_123:example.com:/docs:https://example.com/docs",
      operation: "delete",
      status: "retryable",
      publisherKind: "in_process",
      failureMessage: "temporary host failure",
      completedAt: "2025-01-01T00:01:00.000Z"
    });

    const publisher: DocumentPublisher = {
      upsert: vi.fn(async (document) => ({
        documentId: document.externalId,
        status: "processed"
      })),
      remove: vi.fn(async () => undefined)
    };

    const result = await runAttachedCrawler({
      persistence,
      documentPublisher: publisher,
      source: {
        scopeKey: source.scopeKey,
        baseUrl: source.baseUrl
      },
      pageLimit: 1,
      fetchPage: async () => ({
        url: "https://example.com/docs",
        title: "Docs Home",
        text: content,
        html: "<html></html>",
        httpStatus: 200,
        links: []
      })
    });

    expect(result.stats.pagesUnchanged).toBe(1);
    expect(result.stats.publicationFailures).toBe(0);
    expect(result.run.statusReason).toBeNull();
    expect(publisher.remove).not.toHaveBeenCalled();
    expect(persistence.state.publicationAttempts).toHaveLength(2);
    expect(persistence.state.publicationAttempts[1]).toEqual(
      expect.objectContaining({
        operation: "upsert",
        status: "delivered",
        responseStatus: "observed_alive"
      })
    );
  });

  it("removes previously published documents when a page becomes permanently unavailable", async () => {
    const persistence = createFakePersistence();
    const source = await persistence.sources.create({
      scopeKey: "acct_123:example.com:/docs",
      baseUrl: "https://example.com/docs",
      mode: "attached"
    });
    const previousRun = await persistence.runs.create({
      sourceId: source.id,
      mode: "attached",
      pageLimit: 1,
      status: "completed",
      runStartedAt: "2025-01-01T00:00:00.000Z",
      finishedAt: "2025-01-01T00:01:00.000Z"
    });
    const page = await persistence.pages.upsert({
      sourceId: source.id,
      runId: previousRun.id,
      frontierUrl: "https://example.com/docs/missing",
      fetchedUrl: "https://example.com/docs/missing",
      canonicalUrl: "https://example.com/docs/missing",
      canonicalUrlKey: "https://example.com/docs/missing",
      title: "Missing",
      content: "old content",
      contentHash: "hash_1",
      status: "success",
      httpStatus: 200
    });
    await persistence.publicationAttempts.create({
      pageRecordId: page.id,
      externalId: "acct_123:example.com:/docs:https://example.com/docs/missing",
      operation: "upsert",
      status: "delivered",
      publisherKind: "in_process",
      responseDocumentId: "doc_missing",
      responseStatus: "processed",
      completedAt: "2025-01-01T00:01:00.000Z"
    });

    const publisher: DocumentPublisher = {
      upsert: vi.fn(async (document) => ({
        documentId: document.externalId,
        status: "processed"
      })),
      remove: vi.fn(async () => undefined)
    };

    const result = await runAttachedCrawler({
      persistence,
      documentPublisher: publisher,
      source: {
        scopeKey: source.scopeKey,
        baseUrl: source.baseUrl
      },
      pageLimit: 1,
      fetchPage: async () => ({
        url: "https://example.com/docs/missing",
        frontierUrl: "https://example.com/docs/missing",
        title: "Missing",
        text: "",
        html: "<html></html>",
        httpStatus: 404,
        error: "Not Found",
        links: []
      })
    });

    expect(publisher.remove).toHaveBeenCalledWith({
      externalId: "acct_123:example.com:/docs:https://example.com/docs/missing"
    });
    expect(result.stats.pagesPublished).toBe(1);
    expect(result.stats.publicationFailures).toBe(0);
    expect(persistence.state.publicationAttempts.at(-1)).toEqual(
      expect.objectContaining({
        operation: "delete",
        status: "delivered"
      })
    );
  });

  it("converges on an existing source when concurrent creation hits a unique constraint", async () => {
    const persistence = createFakePersistence();
    const existing = await persistence.sources.create({
      scopeKey: "acct_123:example.com:/docs",
      baseUrl: "https://example.com/docs",
      mode: "attached"
    });
    let firstLookup = true;
    const originalGetByScopeKey = persistence.sources.getByScopeKey;
    persistence.sources.getByScopeKey = vi.fn(async (scopeKey) => {
      if (firstLookup) {
        firstLookup = false;
        return null;
      }
      return originalGetByScopeKey(scopeKey);
    });
    persistence.sources.create = vi.fn(async () => {
      const error = new Error("duplicate key");
      Object.assign(error, { code: "23505" });
      throw error;
    });

    const publisher: DocumentPublisher = {
      upsert: vi.fn(async (document) => ({
        documentId: document.externalId,
        status: "processed"
      })),
      remove: vi.fn(async () => undefined)
    };

    const result = await runAttachedCrawler({
      persistence,
      documentPublisher: publisher,
      source: {
        scopeKey: existing.scopeKey,
        baseUrl: existing.baseUrl
      },
      pageLimit: 1,
      fetchPage: async () => ({
        url: "https://example.com/docs",
        title: "Docs Home",
        text: "hello crawler",
        html: "<html></html>",
        httpStatus: 200,
        links: []
      })
    });

    expect(result.source.id).toBe(existing.id);
    expect(persistence.state.sources).toHaveLength(1);
  });
});
