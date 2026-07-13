import { randomUUID } from "node:crypto";

import request from "supertest";
import { describe, expect, it } from "vitest";

import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

describe("document contract", () => {
  it("lists chunk summaries for a document and returns chunk detail", async () => {
    const { app, repositories } = createTestApp();
    const session = await issueTestSession(app, "document-chunks@example.com");

    const createResponse = await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({
        title: "Chunk inspectable document",
        content: "Body content for chunk inspection.",
      })
      .expect(202);

    const documentId = createResponse.body.documentId as string;
    const document = repositories.documentRepository.items.get(documentId);
    if (!document) {
      throw new Error("document missing after create");
    }
    const workspaceId = document.workspaceId;

    const chunkAlpha = {
      id: randomUUID(),
      documentId,
      workspaceId,
      chunkIndex: 0,
      content: "First chunk content that the inspector should preview.",
      searchText: "first chunk searchable",
      embedding: Array.from({ length: 4 }, () => 0.1),
      startOffset: 0,
      endOffset: 54,
      metadata: { heading: "Intro" },
      createdAt: new Date("2025-01-01T00:00:00.000Z"),
    };
    const chunkBravo = {
      id: randomUUID(),
      documentId,
      workspaceId,
      chunkIndex: 1,
      content: "Second chunk content for the next page.",
      searchText: "second chunk searchable",
      embedding: Array.from({ length: 4 }, () => 0.2),
      startOffset: 54,
      endOffset: 93,
      metadata: {},
      createdAt: new Date("2025-01-01T00:00:01.000Z"),
    };
    await repositories.chunkRepository.replaceForDocument(documentId, [chunkAlpha, chunkBravo]);

    const listResponse = await request(app)
      .get(`/api/v1/document/${documentId}/chunks`)
      .set(adminSessionHeaders(session))
      .expect(200);

    expect(listResponse.body).toEqual({
      documentId,
      chunks: [
        {
          id: chunkAlpha.id,
          chunkIndex: 0,
          contentPreview: chunkAlpha.content,
          contentLength: chunkAlpha.content.length,
          startOffset: 0,
          endOffset: 54,
          dateFrom: null,
          dateTo: null,
        },
        {
          id: chunkBravo.id,
          chunkIndex: 1,
          contentPreview: chunkBravo.content,
          contentLength: chunkBravo.content.length,
          startOffset: 54,
          endOffset: 93,
          dateFrom: null,
          dateTo: null,
        },
      ],
    });

    const detailResponse = await request(app)
      .get(`/api/v1/document/${documentId}/chunks/${chunkBravo.id}`)
      .set(adminSessionHeaders(session))
      .expect(200);

    expect(detailResponse.body).toEqual({
      id: chunkBravo.id,
      documentId,
      workspaceId,
      chunkIndex: 1,
      content: chunkBravo.content,
      searchText: "second chunk searchable",
      startOffset: 54,
      endOffset: 93,
      metadata: {},
      createdAt: "2025-01-01T00:00:01.000Z",
      embeddingDimensions: 4,
    });

    await request(app)
      .get(`/api/v1/document/${documentId}/chunks/${randomUUID()}`)
      .set(adminSessionHeaders(session))
      .expect(404);
  });


  it("lists persisted document sources with document counts", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "document-sources@example.com");

    await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({
        title: "Source page",
        content: "Source scoped content.",
        source: {
          kind: "website",
          url: "https://example.com/docs",
        },
      })
      .expect(202);

    const response = await request(app)
      .get("/api/v1/document/sources")
      .set(adminSessionHeaders(session))
      .expect(200);

    expect(response.body.sources).toEqual([
      expect.objectContaining({
        id: expect.any(String),
        kind: "website",
        name: "example.com/docs",
        externalId: "https://example.com/docs",
        lastSyncStatus: null,
        lastSyncedAt: null,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        documentCount: 1,
        documentEnrichmentOverride: "inherit",
      }),
    ]);
  });

  it("updates source enrichment override and reprocesses source documents with a one-run override", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "document-source-enrichment@example.com");

    await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({
        title: "Events source page",
        content: "Summer workshop details.",
        source: {
          kind: "website",
          url: "https://example.com/events",
        },
      })
      .expect(202);

    const listResponse = await request(app)
      .get("/api/v1/document/sources")
      .set(adminSessionHeaders(session))
      .expect(200);
    const sourceId = listResponse.body.sources[0].id as string;

    const updateResponse = await request(app)
      .patch(`/api/v1/document/sources/${sourceId}`)
      .set(adminSessionHeaders(session))
      .send({ documentEnrichmentOverride: "on" })
      .expect(200);

    expect(updateResponse.body).toMatchObject({
      id: sourceId,
      documentEnrichmentOverride: "on",
    });

    const reprocessResponse = await request(app)
      .post(`/api/v1/document/sources/${sourceId}/reprocess`)
      .set(adminSessionHeaders(session))
      .send({ documentEnrichmentOverride: "off" })
      .expect(202);

    expect(reprocessResponse.body).toMatchObject({
      sourceId,
      workspaceId: expect.any(String),
      queuedDocumentCount: 1,
      skippedDocumentCount: 0,
      status: "queued",
    });
  });

  it("imports uploaded files under a workspace upload source", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "document-import-source@example.com");

    await request(app)
      .post("/api/v1/document/import")
      .set(adminSessionHeaders(session))
      .field("title", "Imported source text")
      .attach("file", Buffer.from("Imported content"), {
        filename: "import-source.txt",
        contentType: "text/plain",
      })
      .expect(202);

    const response = await request(app)
      .get("/api/v1/document/sources")
      .set(adminSessionHeaders(session))
      .expect(200);

    expect(response.body.sources).toEqual([
      expect.objectContaining({
        kind: "upload",
        name: "Uploads",
        externalId: "workspace-uploads",
        documentCount: 1,
      }),
    ]);
  });

  it("searches documents and returns a stable search snapshot with shared diagnostics", async () => {
    const { app, repositories } = createTestApp();

    const session = await issueTestSession(app, "document-search@example.com");

    await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({
        title: "Pricing FAQ",
        content: "Annual pricing includes support and onboarding details.",
        metadata: { language: "en" },
      });

    const response = await request(app)
      .post("/api/v1/document/search")
      .set(adminSessionHeaders(session))
      .send({
        query: "pricing support",
        metadataFilter: { language: "en" },
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      searchId: expect.any(String),
      mode: "live",
      query: "pricing support",
      resultCount: 1,
      results: [
        expect.objectContaining({
          title: "Pricing FAQ",
          rank: 1,
          actions: expect.arrayContaining([
            expect.objectContaining({ type: "open_document", status: "available" }),
          ]),
        }),
      ],
    });
    expect(response.body).not.toHaveProperty("activityTrace");
    expect(response.body).not.toHaveProperty("debug");

    const debugResponse = await request(app)
      .post("/api/v1/document/search")
      .set(adminSessionHeaders(session))
      .send({
        query: "pricing support",
        metadataFilter: { language: "en" },
        includeDebug: true,
      });

    expect(debugResponse.status).toBe(200);
    expect(debugResponse.body.debug).toMatchObject({
      activityTrace: expect.objectContaining({
        traceId: expect.any(String),
      }),
    });

    const auditEvent = await repositories.auditEventRepository.findDocumentSearchEventBySearchId(
      session.workspaceId,
      response.body.searchId,
    );
    expect(auditEvent?.metadata).toMatchObject({
      executionSurface: "documents",
    });
  });

  it("marks MCP capability-originated document searches in audit metadata", async () => {
    const { app, repositories } = createTestApp();
    const session = await issueTestSession(app, "document-search-mcp@example.com");

    await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({
        title: "Pricing FAQ",
        content: "Annual pricing includes support and onboarding details.",
      });

    const response = await request(app)
      .post("/api/v1/document/search")
      .set(adminSessionHeaders(session))
      .set("x-radioso-capability-client", "mcp")
      .send({ query: "pricing support" });

    expect(response.status).toBe(200);
    const auditEvent = await repositories.auditEventRepository.findDocumentSearchEventBySearchId(
      session.workspaceId,
      response.body.searchId,
    );
    expect(auditEvent?.metadata).toMatchObject({
      executionSurface: "mcp_capability",
    });
  });

  it("lists and replays document search history snapshots", async () => {
    const { app } = createTestApp();

    const session = await issueTestSession(app, "document-search-history@example.com");

    await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({
        title: "Troubleshooting Guide",
        content: "Reset the service when onboarding fails.",
      });

    const searchResponse = await request(app)
      .post("/api/v1/document/search")
      .set(adminSessionHeaders(session))
      .send({
        query: "onboarding fails",
      });

    const listResponse = await request(app)
      .get("/api/v1/document/search/history")
      .set(adminSessionHeaders(session));

    expect(listResponse.status).toBe(200);
    expect(listResponse.body.searches).toEqual([
      expect.objectContaining({
        searchId: searchResponse.body.searchId,
        query: "onboarding fails",
        resultCount: 1,
        activityTraceAvailable: true,
      }),
    ]);
    expect(listResponse.body.nextCursor).toBeNull();
    expect(listResponse.body.hasMore).toBe(false);

    const replayResponse = await request(app)
      .get(`/api/v1/document/search/history/${searchResponse.body.searchId}`)
      .set(adminSessionHeaders(session));

    expect(replayResponse.status).toBe(200);
    expect(replayResponse.body).toMatchObject({
      searchId: searchResponse.body.searchId,
      mode: "snapshot",
      query: "onboarding fails",
      resultCount: 1,
      results: [
        expect.objectContaining({
          title: "Troubleshooting Guide",
        }),
      ],
    });
    expect(replayResponse.body).not.toHaveProperty("activityTrace");
    expect(replayResponse.body).not.toHaveProperty("debug");

    const debugReplayResponse = await request(app)
      .get(`/api/v1/document/search/history/${searchResponse.body.searchId}?includeDebug=true`)
      .set(adminSessionHeaders(session));

    expect(debugReplayResponse.status).toBe(200);
    expect(debugReplayResponse.body.debug).toMatchObject({
      activityTrace: expect.objectContaining({
        traceId: expect.any(String),
      }),
    });
  });

  it("replays search history after document deletion with unavailable open actions", async () => {
    const { app } = createTestApp();

    const session = await issueTestSession(app, "document-search-history-deleted@example.com");

    const createResponse = await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({
        title: "Temporary Guide",
        content: "Delete me after search replay is stored.",
      });

    const searchResponse = await request(app)
      .post("/api/v1/document/search")
      .set(adminSessionHeaders(session))
      .send({
        query: "delete me",
      });

    await request(app)
      .delete(`/api/v1/document/${createResponse.body.documentId}`)
      .set(adminSessionHeaders(session))
      .expect(204);

    const replayResponse = await request(app)
      .get(`/api/v1/document/search/history/${searchResponse.body.searchId}`)
      .set(adminSessionHeaders(session));

    expect(replayResponse.status).toBe(200);
    expect(replayResponse.body).toMatchObject({
      searchId: searchResponse.body.searchId,
      mode: "snapshot",
      query: "delete me",
      resultCount: 1,
      results: [
        expect.objectContaining({
          documentId: createResponse.body.documentId,
          title: "Temporary Guide",
          actions: expect.arrayContaining([
            expect.objectContaining({ type: "open_document", status: "unavailable" }),
          ]),
        }),
      ],
    });
  });

  it("accepts a supported file import for background processing for a session-authenticated workspace", async () => {
    const { app } = createTestApp();

    const session = await issueTestSession(app, "document-import@example.com");

    const response = await request(app)
      .post("/api/v1/document/import")
      .set(adminSessionHeaders(session))
      .field("title", "Imported text")
      .attach("file", Buffer.from("Imported content"), {
        filename: "import.txt",
        contentType: "text/plain",
      });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      documentId: expect.any(String),
      status: "queued",
    });
  });

  it("rejects unsupported imports with a bad_request error", async () => {
    const { app } = createTestApp();

    const session = await issueTestSession(app, "document-import-unsupported@example.com");

    const response = await request(app)
      .post("/api/v1/document/import")
      .set(adminSessionHeaders(session))
      .attach("file", Buffer.from("png"), {
        filename: "avatar.png",
        contentType: "image/png",
      });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: {
        code: "bad_request",
        message: "Unsupported document type",
      },
    });
  });

  it("rejects oversized imports before queuing processing", async () => {
    const { app } = createTestApp();

    const session = await issueTestSession(app, "document-import-too-large@example.com");

    const response = await request(app)
      .post("/api/v1/document/import")
      .set(adminSessionHeaders(session))
      .attach("file", Buffer.alloc(10 * 1024 * 1024 + 1, "a"), {
        filename: "too-large.txt",
        contentType: "text/plain",
      });

    expect(response.status).toBe(413);
    expect(response.body).toMatchObject({
      error: {
        code: "payload_too_large",
        message: "Uploaded file exceeds maximum size",
      },
    });
  });

  it("accepts a document for background processing for a session-authenticated workspace", async () => {
    const { app } = createTestApp();

    const session = await issueTestSession(app, "document@example.com");

    const response = await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({
        title: "Introduction to Test",
        content: "This is a content to be parsed",
      });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      documentId: expect.any(String),
      status: "queued",
    });
  });

  it("rejects oversized inline documents with a clear client error", async () => {
    const { app } = createTestApp();

    const session = await issueTestSession(app, "document-inline-too-large@example.com");

    const response = await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({
        title: "Large inline document",
        content: "a".repeat(1024 * 1024 + 1),
      });

    expect(response.status).toBe(413);
    expect(response.body).toMatchObject({
      error: {
        code: "payload_too_large",
        message: "Document content exceeds the inline size limit. Import the file instead.",
      },
    });
  });

  it("returns, updates, and reprocesses a document for a session-authenticated workspace", async () => {
    const { app } = createTestApp();

    const session = await issueTestSession(app, "document-edit@example.com");

    const createResponse = await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({
        title: "Original title",
        content: "Original content",
      });

    const getResponse = await request(app)
      .get(`/api/v1/document/${createResponse.body.documentId}`)
      .set(adminSessionHeaders(session));

    expect(getResponse.status).toBe(200);
    expect(getResponse.body).toMatchObject({
      id: createResponse.body.documentId,
      title: "Original title",
      content: "Original content",
      status: "ready",
      ragStatus: "processed",
    });

    const updateResponse = await request(app)
      .put(`/api/v1/document/${createResponse.body.documentId}`)
      .set(adminSessionHeaders(session))
      .send({
        title: "Updated title",
        content: "Updated content",
      });

    expect(updateResponse.status).toBe(202);
    expect(updateResponse.body).toMatchObject({
      documentId: createResponse.body.documentId,
      status: "queued",
    });

    const reprocessResponse = await request(app)
      .post(`/api/v1/document/${createResponse.body.documentId}/reprocess`)
      .set(adminSessionHeaders(session))
      .send({ documentEnrichmentOverride: "on" });

    expect(reprocessResponse.status).toBe(202);
    expect(reprocessResponse.body).toMatchObject({
      documentId: createResponse.body.documentId,
      status: "queued",
    });

    const listResponse = await request(app)
      .get("/api/v1/document/")
      .set(adminSessionHeaders(session));

    expect(listResponse.status).toBe(200);
    expect(listResponse.body.documents).toEqual([
      expect.objectContaining({
        id: createResponse.body.documentId,
        title: "Updated title",
        status: "ready",
        ragStatus: "processed",
      }),
    ]);
    expect(listResponse.body.nextCursor).toBeNull();
    expect(listResponse.body.hasMore).toBe(false);
  });

  it("supports cursor pagination for document lists", async () => {
    const { app } = createTestApp();

    const session = await issueTestSession(app, "document-list-cursor@example.com");

    for (const title of ["Doc A", "Doc B", "Doc C"]) {
      await request(app)
        .post("/api/v1/document/")
        .set(adminSessionHeaders(session))
        .send({ title, content: `${title} content` });
    }

    const firstPage = await request(app)
      .get("/api/v1/document/?limit=2")
      .set(adminSessionHeaders(session));

    expect(firstPage.status).toBe(200);
    expect(firstPage.body.documents).toHaveLength(2);
    expect(firstPage.body.hasMore).toBe(true);
    expect(firstPage.body.nextCursor).toEqual(expect.any(String));

    const secondPage = await request(app)
      .get(`/api/v1/document/?limit=2&cursor=${encodeURIComponent(firstPage.body.nextCursor)}`)
      .set(adminSessionHeaders(session));

    expect(secondPage.status).toBe(200);
    expect(secondPage.body.documents).toHaveLength(1);
    expect(secondPage.body.hasMore).toBe(false);
    expect(secondPage.body.nextCursor).toBeNull();
  });

  it("rejects invalid document list paging query values with a client error", async () => {
    const { app } = createTestApp();

    const session = await issueTestSession(app, "document-list-query-error@example.com");

    const response = await request(app)
      .get("/api/v1/document/?limit=foo")
      .set(adminSessionHeaders(session));

    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({
      code: "bad_request",
      message: "Invalid request query",
    });
  });

  it("rejects malformed document cursors with a client error", async () => {
    const { app } = createTestApp();

    const session = await issueTestSession(app, "document-list-bad-cursor@example.com");

    const response = await request(app)
      .get("/api/v1/document/?cursor=not-a-cursor")
      .set(adminSessionHeaders(session));

    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({
      code: "bad_request",
      message: "Invalid cursor",
    });
  });

  it("rejects inline updates for imported documents", async () => {
    const { app } = createTestApp();

    const session = await issueTestSession(app, "document-import-update@example.com");

    const importResponse = await request(app)
      .post("/api/v1/document/import")
      .set(adminSessionHeaders(session))
      .field("title", "Imported text")
      .attach("file", Buffer.from("Imported content"), {
        filename: "import.txt",
        contentType: "text/plain",
      });

    expect(importResponse.status).toBe(202);

    const updateResponse = await request(app)
      .put(`/api/v1/document/${importResponse.body.documentId}`)
      .set(adminSessionHeaders(session))
      .send({
        title: "Updated title",
        content: "Updated content",
      });

    expect(updateResponse.status).toBe(409);
    expect(updateResponse.body).toMatchObject({
      error: {
        code: "conflict",
        message: "Imported documents cannot be updated through the inline document API",
      },
    });
  });

  it("deletes a document for a session-authenticated workspace", async () => {
    const { app } = createTestApp();

    const session = await issueTestSession(app, "document-delete@example.com");

    const createResponse = await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({
        title: "Disposable title",
        content: "Disposable content",
      });

    const deleteResponse = await request(app)
      .delete(`/api/v1/document/${createResponse.body.documentId}`)
      .set(adminSessionHeaders(session));

    expect(deleteResponse.status).toBe(204);
    expect(deleteResponse.body).toEqual({});

    const listResponse = await request(app)
      .get("/api/v1/document/")
      .set(adminSessionHeaders(session));

    expect(listResponse.status).toBe(200);
    expect(listResponse.body.documents).toEqual([]);
  });

  it("persists and returns document metadata on POST and GET", async () => {
    const { app } = createTestApp();

    const session = await issueTestSession(app, "document-metadata@example.com");

    const createResponse = await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({
        title: "Metadata document",
        content: "Content with metadata",
        metadata: { sourceUrl: "https://example.com", language: "en" },
      });

    expect(createResponse.status).toBe(202);

    const getResponse = await request(app)
      .get(`/api/v1/document/${createResponse.body.documentId}`)
      .set(adminSessionHeaders(session));

    expect(getResponse.status).toBe(200);
    expect(getResponse.body).toMatchObject({
      id: createResponse.body.documentId,
      metadata: { sourceUrl: "https://example.com", language: "en" },
    });
  });

  it("treats POST with the same externalDocumentId as an idempotent write within one workspace", async () => {
    const { app } = createTestApp();

    const session = await issueTestSession(app, "document-external-id@example.com");

    const firstResponse = await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({
        title: "External document",
        content: "First content",
        externalDocumentId: "crm-123",
      });

    const secondResponse = await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({
        title: "External document",
        content: "Second content",
        externalDocumentId: "crm-123",
      });

    expect(firstResponse.status).toBe(202);
    expect(secondResponse.status).toBe(202);
    expect(secondResponse.body.documentId).toBe(firstResponse.body.documentId);

    const getResponse = await request(app)
      .get(`/api/v1/document/${firstResponse.body.documentId}`)
      .set(adminSessionHeaders(session));

    expect(getResponse.status).toBe(200);
    expect(getResponse.body).toMatchObject({
      id: firstResponse.body.documentId,
      content: "Second content",
      externalDocumentId: "crm-123",
    });
  });

  it("rejects blank externalDocumentId values", async () => {
    const { app } = createTestApp();

    const session = await issueTestSession(app, "document-external-id-blank@example.com");

    const response = await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({
        title: "Blank external ID",
        content: "Content",
        externalDocumentId: "   ",
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({
      code: "bad_request",
    });
  });

  it("returns empty metadata object when document is created without metadata", async () => {
    const { app } = createTestApp();

    const session = await issueTestSession(app, "document-no-metadata@example.com");

    const createResponse = await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({
        title: "No metadata document",
        content: "Content without metadata",
      });

    expect(createResponse.status).toBe(202);

    const getResponse = await request(app)
      .get(`/api/v1/document/${createResponse.body.documentId}`)
      .set(adminSessionHeaders(session));

    expect(getResponse.status).toBe(200);
    expect(getResponse.body).toMatchObject({
      id: createResponse.body.documentId,
      metadata: {},
      sourceId: null,
      source: null,
    });
  });

  it("creates and reuses workspace-local website sources from document requests", async () => {
    const { app, repositories } = createTestApp();

    const session = await issueTestSession(app, "document-source-website@example.com");

    const firstResponse = await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({
        title: "Pricing",
        content: "Pricing content",
        externalDocumentId: "https://example.com/docs/pricing",
        source: {
          kind: "website",
          url: "https://example.com/docs/",
        },
        metadata: {
          sourceUrl: "https://example.com/docs/pricing",
        },
      });

    const secondResponse = await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({
        title: "Contact",
        content: "Contact content",
        externalDocumentId: "https://example.com/docs/contact",
        source: {
          kind: "website",
          url: "https://example.com/docs",
        },
      });

    expect(firstResponse.status).toBe(202);
    expect(secondResponse.status).toBe(202);
    expect(repositories.documentSourceRepository.items.size).toBe(1);

    const firstDocument = await request(app)
      .get(`/api/v1/document/${firstResponse.body.documentId}`)
      .set(adminSessionHeaders(session));
    const secondDocument = await request(app)
      .get(`/api/v1/document/${secondResponse.body.documentId}`)
      .set(adminSessionHeaders(session));

    expect(firstDocument.status).toBe(200);
    expect(secondDocument.status).toBe(200);
    expect(firstDocument.body.sourceId).toBe(secondDocument.body.sourceId);
    expect(firstDocument.body.source).toMatchObject({
      id: firstDocument.body.sourceId,
      kind: "website",
      name: "example.com/docs",
      externalId: "https://example.com/docs",
    });

    const linkedResponse = await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({
        title: "FAQ",
        content: "FAQ content",
        externalDocumentId: "https://example.com/docs/faq",
        source: {
          id: firstDocument.body.sourceId,
        },
      });
    const linkedDocument = await request(app)
      .get(`/api/v1/document/${linkedResponse.body.documentId}`)
      .set(adminSessionHeaders(session));

    expect(linkedResponse.status).toBe(202);
    expect(linkedDocument.body.sourceId).toBe(firstDocument.body.sourceId);

    const listResponse = await request(app)
      .get("/api/v1/document/")
      .set(adminSessionHeaders(session));

    expect(listResponse.status).toBe(200);
    expect(listResponse.body.documents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: firstResponse.body.documentId,
        sourceId: firstDocument.body.sourceId,
        source: expect.objectContaining({ kind: "website" }),
      }),
    ]));
  });

  it("keeps document sources bounded to each workspace", async () => {
    const { app, repositories } = createTestApp();

    const firstSession = await issueTestSession(app, "document-source-first@example.com");
    const secondSession = await issueTestSession(app, "document-source-second@example.com");

    const firstResponse = await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(firstSession))
      .send({
        title: "First workspace",
        content: "First content",
        externalDocumentId: "https://example.com/docs/a",
        source: {
          kind: "website",
          url: "https://example.com/docs",
        },
      });
    const firstDocument = await request(app)
      .get(`/api/v1/document/${firstResponse.body.documentId}`)
      .set(adminSessionHeaders(firstSession));

    const crossWorkspaceResponse = await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(secondSession))
      .send({
        title: "Cross workspace",
        content: "Cross workspace content",
        source: {
          id: firstDocument.body.sourceId,
        },
      });

    const secondResponse = await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(secondSession))
      .send({
        title: "Second workspace",
        content: "Second content",
        externalDocumentId: "https://example.com/docs/a",
        source: {
          kind: "website",
          url: "https://example.com/docs",
        },
      });
    const secondDocument = await request(app)
      .get(`/api/v1/document/${secondResponse.body.documentId}`)
      .set(adminSessionHeaders(secondSession));

    expect(crossWorkspaceResponse.status).toBe(404);
    expect(crossWorkspaceResponse.body.error).toMatchObject({
      code: "not_found",
      message: "Document source not found",
    });
    expect(secondDocument.status).toBe(200);
    expect(secondDocument.body.sourceId).not.toBe(firstDocument.body.sourceId);
    expect(repositories.documentSourceRepository.items.size).toBe(2);
  });

  it("preserves metadata on PUT without metadata and replaces on PUT with metadata", async () => {
    const { app } = createTestApp();

    const session = await issueTestSession(app, "document-put-metadata@example.com");

    const createResponse = await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({
        title: "Original",
        content: "Original content",
        metadata: { sourceUrl: "https://example.com", language: "en" },
      });

    // PUT without metadata — existing metadata should be preserved
    await request(app)
      .put(`/api/v1/document/${createResponse.body.documentId}`)
      .set(adminSessionHeaders(session))
      .send({ title: "Updated", content: "Updated content" });

    const afterNoMetadataUpdate = await request(app)
      .get(`/api/v1/document/${createResponse.body.documentId}`)
      .set(adminSessionHeaders(session));

    expect(afterNoMetadataUpdate.body.metadata).toEqual({
      sourceUrl: "https://example.com",
      language: "en",
    });

    // PUT with metadata — should replace
    await request(app)
      .put(`/api/v1/document/${createResponse.body.documentId}`)
      .set(adminSessionHeaders(session))
      .send({ title: "Updated again", content: "Updated content again", metadata: { language: "fr" } });

    const afterMetadataUpdate = await request(app)
      .get(`/api/v1/document/${createResponse.body.documentId}`)
      .set(adminSessionHeaders(session));

    expect(afterMetadataUpdate.body.metadata).toEqual({ language: "fr" });
  });

  it("returns externalDocumentId on GET and list responses when present", async () => {
    const { app } = createTestApp();

    const session = await issueTestSession(app, "document-external-id-read@example.com");

    const createResponse = await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({
        title: "Readable external doc",
        content: "Readable content",
        externalDocumentId: "crm-123",
      });

    const getResponse = await request(app)
      .get(`/api/v1/document/${createResponse.body.documentId}`)
      .set(adminSessionHeaders(session));

    const listResponse = await request(app)
      .get("/api/v1/document/")
      .set(adminSessionHeaders(session));

    expect(getResponse.status).toBe(200);
    expect(getResponse.body.externalDocumentId).toBe("crm-123");
    expect(listResponse.status).toBe(200);
    expect(listResponse.body.documents).toEqual([
      expect.objectContaining({
        id: createResponse.body.documentId,
        externalDocumentId: "crm-123",
      }),
    ]);
  });

  it("preserves repeated create behavior when externalDocumentId is omitted", async () => {
    const { app } = createTestApp();

    const session = await issueTestSession(app, "document-external-id-omitted@example.com");

    const firstResponse = await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({
        title: "No external ID",
        content: "First content",
      });

    const secondResponse = await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({
        title: "No external ID",
        content: "First content",
      });

    expect(firstResponse.status).toBe(202);
    expect(secondResponse.status).toBe(202);
    expect(secondResponse.body.documentId).not.toBe(firstResponse.body.documentId);
  });

  it("rejects attempts to change externalDocumentId once it is set", async () => {
    const { app } = createTestApp();

    const session = await issueTestSession(app, "document-external-id-immutable@example.com");

    const createResponse = await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({
        title: "Immutable external doc",
        content: "Original content",
        externalDocumentId: "crm-123",
      });

    const updateResponse = await request(app)
      .put(`/api/v1/document/${createResponse.body.documentId}`)
      .set(adminSessionHeaders(session))
      .send({
        title: "Immutable external doc",
        content: "Updated content",
        externalDocumentId: "crm-456",
      });

    expect(updateResponse.status).toBe(409);
    expect(updateResponse.body.error).toMatchObject({
      code: "conflict",
      message: "externalDocumentId cannot be changed once set",
    });
  });

  it("returns not_found when deleting a document outside the authenticated account", async () => {
    const { app } = createTestApp();

    const ownerSession = await issueTestSession(app, "document-delete-owner@example.com");
    const intruderSession = await issueTestSession(app, "document-delete-intruder@example.com");

    const createResponse = await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(ownerSession))
      .send({
        title: "Protected title",
        content: "Protected content",
      });

    const deleteResponse = await request(app)
      .delete(`/api/v1/document/${createResponse.body.documentId}`)
      .set(adminSessionHeaders(intruderSession));

    expect(deleteResponse.status).toBe(404);
    expect(deleteResponse.body).toMatchObject({
      error: {
        code: "not_found",
        message: "Document not found",
      },
    });
  });

  it("lists documents belonging to a specific source", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "source-docs@example.com");

    const docResponse = await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({
        title: "Crawled page",
        content: "Page content.",
        source: { kind: "website", url: "https://list-source.example.com" },
      })
      .expect(202);

    const sourcesResponse = await request(app)
      .get("/api/v1/document/sources")
      .set(adminSessionHeaders(session))
      .expect(200);

    const source = sourcesResponse.body.sources.find(
      (s: { kind: string }) => s.kind === "website",
    );
    expect(source).toBeDefined();

    const listResponse = await request(app)
      .get(`/api/v1/document/sources/${source.id}/documents`)
      .set(adminSessionHeaders(session))
      .expect(200);

    expect(listResponse.body.total).toBe(1);
    expect(listResponse.body.documents[0].id).toBe(docResponse.body.documentId);
  });

  it("returns 404 when listing documents for a non-existent source", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "source-404@example.com");

    await request(app)
      .get("/api/v1/document/sources/00000000-0000-4000-8000-000000000099/documents")
      .set(adminSessionHeaders(session))
      .expect(404);
  });

  it("deletes a source and all its documents", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "source-delete@example.com");

    await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({
        title: "Deletable page",
        content: "Will be removed.",
        source: { kind: "website", url: "https://delete-source.example.com" },
      })
      .expect(202);

    const sourcesResponse = await request(app)
      .get("/api/v1/document/sources")
      .set(adminSessionHeaders(session))
      .expect(200);

    const source = sourcesResponse.body.sources.find(
      (s: { kind: string }) => s.kind === "website",
    );

    await request(app)
      .delete(`/api/v1/document/sources/${source.id}`)
      .set(adminSessionHeaders(session))
      .expect(204);

    const afterResponse = await request(app)
      .get("/api/v1/document/sources")
      .set(adminSessionHeaders(session))
      .expect(200);

    expect(afterResponse.body.sources.filter(
      (s: { kind: string }) => s.kind === "website",
    )).toHaveLength(0);

    const docsResponse = await request(app)
      .get("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .expect(200);

    expect(docsResponse.body.documents).toHaveLength(0);
  });

  it("rejects deleting the synthetic manually-added source", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "source-synthetic@example.com");

    await request(app)
      .delete("/api/v1/document/sources/00000000-0000-0000-0000-000000000001")
      .set(adminSessionHeaders(session))
      .expect(400);
  });

  it("updates crawl settings for a website source and exposes them via listSources", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "source-config-update@example.com");

    await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({
        title: "Page",
        content: "Body",
        source: { kind: "website", url: "https://patch-source.example.com" },
      })
      .expect(202);

    const sourcesResponse = await request(app)
      .get("/api/v1/document/sources")
      .set(adminSessionHeaders(session))
      .expect(200);
    const source = sourcesResponse.body.sources.find(
      (entry: { kind: string }) => entry.kind === "website",
    );
    expect(source.crawlSettings).toEqual(
      expect.objectContaining({
        url: "https://patch-source.example.com",
        includeUrlPatterns: [],
        excludeUrlPatterns: [],
        preserveContentLinks: true,
      }),
    );

    const patchResponse = await request(app)
      .patch(`/api/v1/document/sources/${source.id}`)
      .set(adminSessionHeaders(session))
      .send({
        crawlSettings: {
          limit: 42,
          includeUrlPatterns: ["/docs/.*"],
          excludeUrlPatterns: ["/admin/.*"],
          preserveContentLinks: false,
        },
      })
      .expect(200);

    expect(patchResponse.body.crawlSettings).toEqual(
      expect.objectContaining({
        url: "https://patch-source.example.com",
        limit: 42,
        includeUrlPatterns: ["/docs/.*"],
        excludeUrlPatterns: ["/admin/.*"],
        preserveContentLinks: false,
      }),
    );

    const afterResponse = await request(app)
      .get("/api/v1/document/sources")
      .set(adminSessionHeaders(session))
      .expect(200);
    const refreshed = afterResponse.body.sources.find(
      (entry: { id: string }) => entry.id === source.id,
    );
    expect(refreshed.crawlSettings).toEqual(
      expect.objectContaining({
        limit: 42,
        includeUrlPatterns: ["/docs/.*"],
        excludeUrlPatterns: ["/admin/.*"],
        preserveContentLinks: false,
      }),
    );
  });

  it("rejects PATCH /sources for the manually-added bucket", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "source-config-manual@example.com");

    await request(app)
      .patch("/api/v1/document/sources/00000000-0000-0000-0000-000000000001")
      .set(adminSessionHeaders(session))
      .send({ crawlSettings: { limit: 5 } })
      .expect(400);
  });
});
