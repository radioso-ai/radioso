import { describe, expect, it, vi } from "vitest";
import {
  buildDocumentPublicationEnvelope,
  createFunctionDocumentPublisher,
  createHttpDocumentPublisher
} from "../../src/index";
import type { DocumentPublicationMetadata } from "../../src/index";

const metadata = {
  sourceUrl: "https://example.com/page-1",
  frontierUrl: "https://example.com/page-1",
  canonicalUrl: "https://example.com/page-1",
  canonicalUrlKey: "https://example.com/page-1",
  contentHash: "hash-1",
  crawlRunId: "run-1",
  sourceId: "source-1",
  sourceScopeKey: "account:acct_1:example.com:/",
  pageStatus: "success",
  httpStatus: 200,
  etag: '"etag-1"',
  lastModified: "Tue, 02 Apr 2024 12:00:00 GMT",
  transportUsed: "http",
  browserFallbackReason: null,
  httpQualityScore: 1,
  lastFetchedAt: "2026-05-03T12:00:00.000Z"
} satisfies DocumentPublicationMetadata;

describe("document publishers", () => {
  it("delegates upsert and remove to function-backed handlers", async () => {
    const upsert = vi.fn(async () => ({
      documentId: "doc-1",
      status: "processed" as const
    }));
    const remove = vi.fn(async () => {});
    const publisher = createFunctionDocumentPublisher({
      upsert,
      remove
    });

    const result = await publisher.upsert({
      externalId: "page-1",
      title: "Title",
      content: "Content",
      metadata
    });
    await publisher.remove({ externalId: "page-1" });

    expect(result).toEqual({
      documentId: "doc-1",
      status: "processed"
    });
    expect(upsert).toHaveBeenCalledWith({
      externalId: "page-1",
      title: "Title",
      content: "Content",
      metadata
    });
    expect(remove).toHaveBeenCalledWith({ externalId: "page-1" });
  });

  it("builds RAG-facing envelopes with stable identity and change metadata", () => {
    const envelope = buildDocumentPublicationEnvelope({
      source: {
        id: "source-1",
        scopeKey: "account:acct_1:example.com:/docs",
        baseUrl: "https://example.com/docs",
        displayName: "Docs",
        mode: "attached",
        status: "active",
        createdAt: "2026-05-03T10:00:00.000Z",
        updatedAt: "2026-05-03T10:00:00.000Z"
      },
      run: {
        id: "run-1",
        sourceId: "source-1",
        mode: "attached",
        status: "running",
        statusReason: null,
        pageLimit: 10,
        speedProfile: "balanced",
        transportModeRequested: "hybrid",
        transportModeEffective: "hybrid",
        pagesDiscovered: 1,
        pagesCrawled: 0,
        pagesFailed: 0,
        pagesUnchanged: 0,
        pagesPublished: 0,
        publicationFailures: 0,
        httpPagesAttempted: 1,
        httpPagesAccepted: 1,
        browserPagesAttempted: 0,
        browserFallbackCount: 0,
        runStartedAt: "2026-05-03T10:01:00.000Z",
        finishedAt: null,
        createdAt: "2026-05-03T10:00:30.000Z"
      },
      page: {
        id: "page-1",
        sourceId: "source-1",
        runId: "run-1",
        frontierUrl: "https://example.com/docs/start?utm=ignored",
        fetchedUrl: "https://example.com/docs/start",
        canonicalUrl: "https://example.com/docs/start",
        canonicalUrlKey: "https://example.com/docs/start",
        title: "Start",
        content: "Current content",
        contentHash: "hash-current",
        status: "success",
        httpStatus: 200,
        etag: '"etag-current"',
        lastModified: "Tue, 02 Apr 2024 12:00:00 GMT",
        transportUsed: "http",
        browserFallbackReason: null,
        httpQualityScore: 0.98,
        error: null,
        lastFetchedAt: "2026-05-03T10:02:00.000Z",
        createdAt: "2026-05-03T10:02:00.000Z",
        updatedAt: "2026-05-03T10:02:00.000Z"
      }
    });

    expect(envelope).toEqual({
      externalId: "account:acct_1:example.com:/docs:https://example.com/docs/start",
      title: "Start",
      content: "Current content",
      metadata: {
        sourceUrl: "https://example.com/docs/start",
        frontierUrl: "https://example.com/docs/start?utm=ignored",
        canonicalUrl: "https://example.com/docs/start",
        canonicalUrlKey: "https://example.com/docs/start",
        contentHash: "hash-current",
        crawlRunId: "run-1",
        sourceId: "source-1",
        sourceScopeKey: "account:acct_1:example.com:/docs",
        pageStatus: "success",
        httpStatus: 200,
        etag: '"etag-current"',
        lastModified: "Tue, 02 Apr 2024 12:00:00 GMT",
        transportUsed: "http",
        browserFallbackReason: null,
        httpQualityScore: 0.98,
        lastFetchedAt: "2026-05-03T10:02:00.000Z"
      }
    });
  });

  it("sends HTTP upserts and removals through the configured endpoint", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          documentId: "doc-2",
          externalId: "page-2",
          status: "received"
        })
      })
      .mockResolvedValueOnce({
        ok: true
      });

    const publisher = createHttpDocumentPublisher({
      baseUrl: "https://host.example.com",
      fetchImpl: fetchMock as typeof fetch
    });

    const result = await publisher.upsert({
      externalId: "page-2",
      title: "HTTP Title",
      content: "HTTP Content",
      metadata: {
        ...metadata,
        sourceUrl: "https://example.com/page-2",
        frontierUrl: "https://example.com/page-2",
        canonicalUrl: "https://example.com/page-2",
        canonicalUrlKey: "https://example.com/page-2",
        contentHash: "hash-2"
      }
    });
    await publisher.remove({ externalId: "page-2" });

    expect(result).toEqual({
      documentId: "doc-2",
      status: "received"
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://host.example.com/documents",
      expect.objectContaining({
        method: "POST"
      })
    );
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
      externalId: "page-2",
      title: "HTTP Title",
      content: "HTTP Content",
      metadata: {
        ...metadata,
        sourceUrl: "https://example.com/page-2",
        frontierUrl: "https://example.com/page-2",
        canonicalUrl: "https://example.com/page-2",
        canonicalUrlKey: "https://example.com/page-2",
        contentHash: "hash-2"
      }
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://host.example.com/documents/page-2",
      expect.objectContaining({
        method: "DELETE"
      })
    );
  });

  it("treats HTTP delete 404 as a successful idempotent remove by default", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404
    });
    const publisher = createHttpDocumentPublisher({
      baseUrl: "https://host.example.com",
      fetchImpl: fetchMock as typeof fetch
    });

    await expect(publisher.remove({ externalId: "missing-page" })).resolves.toBeUndefined();
  });

  it("can be configured to fail HTTP delete 404 responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404
    });
    const publisher = createHttpDocumentPublisher({
      baseUrl: "https://host.example.com",
      fetchImpl: fetchMock as typeof fetch,
      treatDeleteNotFoundAsSuccess: false
    });

    await expect(publisher.remove({ externalId: "missing-page" })).rejects.toThrow(
      "Document delete failed with status 404"
    );
  });
});
