import request from "supertest";
import { describe, expect, it } from "vitest";

import { createTestApp, issueTestToken } from "../support/testApp.js";

describe("document contract", () => {
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
      status: "queued",
      ragStatus: "pending",
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
        status: "queued",
        ragStatus: "pending",
      }),
    ]);
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
