import request from "supertest";
import { describe, expect, it } from "vitest";

import { createTestApp, issueTestToken } from "../support/testApp.js";

describe("document contract", () => {
  it("searches documents and returns a stable search snapshot with shared diagnostics", async () => {
    const { app } = createTestApp();

    const { token } = await issueTestToken(app, "document-search@example.com");

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", `Bearer ${token}`)
      .send({
        title: "Pricing FAQ",
        content: "Annual pricing includes support and onboarding details.",
        metadata: { language: "en" },
      });

    const response = await request(app)
      .post("/api/v1/document/search")
      .set("Authorization", `Bearer ${token}`)
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
      retrievalTrace: expect.objectContaining({
        traceId: expect.any(String),
      }),
    });
  });

  it("lists and replays document search history snapshots", async () => {
    const { app } = createTestApp();

    const { token } = await issueTestToken(app, "document-search-history@example.com");

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", `Bearer ${token}`)
      .send({
        title: "Troubleshooting Guide",
        content: "Reset the service when onboarding fails.",
      });

    const searchResponse = await request(app)
      .post("/api/v1/document/search")
      .set("Authorization", `Bearer ${token}`)
      .send({
        query: "onboarding fails",
      });

    const listResponse = await request(app)
      .get("/api/v1/document/search/history")
      .set("Authorization", `Bearer ${token}`);

    expect(listResponse.status).toBe(200);
    expect(listResponse.body.searches).toEqual([
      expect.objectContaining({
        searchId: searchResponse.body.searchId,
        query: "onboarding fails",
        resultCount: 1,
        traceAvailable: true,
      }),
    ]);

    const replayResponse = await request(app)
      .get(`/api/v1/document/search/history/${searchResponse.body.searchId}`)
      .set("Authorization", `Bearer ${token}`);

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
      retrievalTrace: expect.objectContaining({
        traceId: expect.any(String),
      }),
    });
  });

  it("replays search history after document deletion with unavailable open actions", async () => {
    const { app } = createTestApp();

    const { token } = await issueTestToken(app, "document-search-history-deleted@example.com");

    const createResponse = await request(app)
      .post("/api/v1/document/")
      .set("Authorization", `Bearer ${token}`)
      .send({
        title: "Temporary Guide",
        content: "Delete me after search replay is stored.",
      });

    const searchResponse = await request(app)
      .post("/api/v1/document/search")
      .set("Authorization", `Bearer ${token}`)
      .send({
        query: "delete me",
      });

    await request(app)
      .delete(`/api/v1/document/${createResponse.body.documentId}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(204);

    const replayResponse = await request(app)
      .get(`/api/v1/document/search/history/${searchResponse.body.searchId}`)
      .set("Authorization", `Bearer ${token}`);

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

  it("accepts a supported file import for background processing for a bearer-authenticated account", async () => {
    const { app } = createTestApp();

    const { token } = await issueTestToken(app, "document-import@example.com");

    const response = await request(app)
      .post("/api/v1/document/import")
      .set("Authorization", `Bearer ${token}`)
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

    const { token } = await issueTestToken(app, "document-import-unsupported@example.com");

    const response = await request(app)
      .post("/api/v1/document/import")
      .set("Authorization", `Bearer ${token}`)
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

    const { token } = await issueTestToken(app, "document-import-too-large@example.com");

    const response = await request(app)
      .post("/api/v1/document/import")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.alloc(10 * 1024 * 1024 + 1, "a"), {
        filename: "too-large.txt",
        contentType: "text/plain",
      });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: {
        code: "bad_request",
        message: "Uploaded file exceeds maximum size",
      },
    });
  });

  it("accepts a document for background processing for a bearer-authenticated account", async () => {
    const { app } = createTestApp();

    const { token } = await issueTestToken(app, "document@example.com");

    const response = await request(app)
      .post("/api/v1/document/")
      .set("Authorization", `Bearer ${token}`)
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

    const { token } = await issueTestToken(app, "document-inline-too-large@example.com");

    const response = await request(app)
      .post("/api/v1/document/")
      .set("Authorization", `Bearer ${token}`)
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

  it("returns, updates, and reprocesses a document for a bearer-authenticated account", async () => {
    const { app } = createTestApp();

    const { token } = await issueTestToken(app, "document-edit@example.com");

    const createResponse = await request(app)
      .post("/api/v1/document/")
      .set("Authorization", `Bearer ${token}`)
      .send({
        title: "Original title",
        content: "Original content",
      });

    const getResponse = await request(app)
      .get(`/api/v1/document/${createResponse.body.documentId}`)
      .set("Authorization", `Bearer ${token}`);

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
      .set("Authorization", `Bearer ${token}`)
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
      .set("Authorization", `Bearer ${token}`);

    expect(reprocessResponse.status).toBe(202);
    expect(reprocessResponse.body).toMatchObject({
      documentId: createResponse.body.documentId,
      status: "queued",
    });

    const listResponse = await request(app)
      .get("/api/v1/document/")
      .set("Authorization", `Bearer ${token}`);

    expect(listResponse.status).toBe(200);
    expect(listResponse.body.documents).toEqual([
      expect.objectContaining({
        id: createResponse.body.documentId,
        title: "Updated title",
        status: "ready",
        ragStatus: "processed",
      }),
    ]);
  });

  it("rejects invalid document list paging query values with a client error", async () => {
    const { app } = createTestApp();

    const { token } = await issueTestToken(app, "document-list-query-error@example.com");

    const response = await request(app)
      .get("/api/v1/document/?limit=foo")
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({
      code: "bad_request",
      message: "Invalid request query",
    });
  });

  it("rejects inline updates for imported documents", async () => {
    const { app } = createTestApp();

    const { token } = await issueTestToken(app, "document-import-update@example.com");

    const importResponse = await request(app)
      .post("/api/v1/document/import")
      .set("Authorization", `Bearer ${token}`)
      .field("title", "Imported text")
      .attach("file", Buffer.from("Imported content"), {
        filename: "import.txt",
        contentType: "text/plain",
      });

    expect(importResponse.status).toBe(202);

    const updateResponse = await request(app)
      .put(`/api/v1/document/${importResponse.body.documentId}`)
      .set("Authorization", `Bearer ${token}`)
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

  it("deletes a document for a bearer-authenticated account", async () => {
    const { app } = createTestApp();

    const { token } = await issueTestToken(app, "document-delete@example.com");

    const createResponse = await request(app)
      .post("/api/v1/document/")
      .set("Authorization", `Bearer ${token}`)
      .send({
        title: "Disposable title",
        content: "Disposable content",
      });

    const deleteResponse = await request(app)
      .delete(`/api/v1/document/${createResponse.body.documentId}`)
      .set("Authorization", `Bearer ${token}`);

    expect(deleteResponse.status).toBe(204);
    expect(deleteResponse.body).toEqual({});

    const listResponse = await request(app)
      .get("/api/v1/document/")
      .set("Authorization", `Bearer ${token}`);

    expect(listResponse.status).toBe(200);
    expect(listResponse.body.documents).toEqual([]);
  });

  it("persists and returns document metadata on POST and GET", async () => {
    const { app } = createTestApp();

    const { token } = await issueTestToken(app, "document-metadata@example.com");

    const createResponse = await request(app)
      .post("/api/v1/document/")
      .set("Authorization", `Bearer ${token}`)
      .send({
        title: "Metadata document",
        content: "Content with metadata",
        metadata: { sourceUrl: "https://example.com", language: "en" },
      });

    expect(createResponse.status).toBe(202);

    const getResponse = await request(app)
      .get(`/api/v1/document/${createResponse.body.documentId}`)
      .set("Authorization", `Bearer ${token}`);

    expect(getResponse.status).toBe(200);
    expect(getResponse.body).toMatchObject({
      id: createResponse.body.documentId,
      metadata: { sourceUrl: "https://example.com", language: "en" },
    });
  });

  it("returns empty metadata object when document is created without metadata", async () => {
    const { app } = createTestApp();

    const { token } = await issueTestToken(app, "document-no-metadata@example.com");

    const createResponse = await request(app)
      .post("/api/v1/document/")
      .set("Authorization", `Bearer ${token}`)
      .send({
        title: "No metadata document",
        content: "Content without metadata",
      });

    expect(createResponse.status).toBe(202);

    const getResponse = await request(app)
      .get(`/api/v1/document/${createResponse.body.documentId}`)
      .set("Authorization", `Bearer ${token}`);

    expect(getResponse.status).toBe(200);
    expect(getResponse.body).toMatchObject({
      id: createResponse.body.documentId,
      metadata: {},
    });
  });

  it("preserves metadata on PUT without metadata and replaces on PUT with metadata", async () => {
    const { app } = createTestApp();

    const { token } = await issueTestToken(app, "document-put-metadata@example.com");

    const createResponse = await request(app)
      .post("/api/v1/document/")
      .set("Authorization", `Bearer ${token}`)
      .send({
        title: "Original",
        content: "Original content",
        metadata: { sourceUrl: "https://example.com", language: "en" },
      });

    // PUT without metadata — existing metadata should be preserved
    await request(app)
      .put(`/api/v1/document/${createResponse.body.documentId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Updated", content: "Updated content" });

    const afterNoMetadataUpdate = await request(app)
      .get(`/api/v1/document/${createResponse.body.documentId}`)
      .set("Authorization", `Bearer ${token}`);

    expect(afterNoMetadataUpdate.body.metadata).toEqual({
      sourceUrl: "https://example.com",
      language: "en",
    });

    // PUT with metadata — should replace
    await request(app)
      .put(`/api/v1/document/${createResponse.body.documentId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Updated again", content: "Updated content again", metadata: { language: "fr" } });

    const afterMetadataUpdate = await request(app)
      .get(`/api/v1/document/${createResponse.body.documentId}`)
      .set("Authorization", `Bearer ${token}`);

    expect(afterMetadataUpdate.body.metadata).toEqual({ language: "fr" });
  });

  it("returns not_found when deleting a document outside the authenticated account", async () => {
    const { app } = createTestApp();

    const { token: ownerToken } = await issueTestToken(app, "document-delete-owner@example.com");
    const { token: intruderToken } = await issueTestToken(app, "document-delete-intruder@example.com");

    const createResponse = await request(app)
      .post("/api/v1/document/")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        title: "Protected title",
        content: "Protected content",
      });

    const deleteResponse = await request(app)
      .delete(`/api/v1/document/${createResponse.body.documentId}`)
      .set("Authorization", `Bearer ${intruderToken}`);

    expect(deleteResponse.status).toBe(404);
    expect(deleteResponse.body).toMatchObject({
      error: {
        code: "not_found",
        message: "Document not found",
      },
    });
  });
});
