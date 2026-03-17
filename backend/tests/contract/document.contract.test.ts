import request from "supertest";
import { describe, expect, it } from "vitest";

import { createTestApp } from "../support/testApp.js";

describe("document contract", () => {
  it("accepts a document for background processing for a bearer-authenticated account", async () => {
    const { app } = createTestApp();

    const register = await request(app).post("/api/v1/auth/register").send({
      email: "document@example.com",
      password: "verysecurepassword",
    });
    const token = await request(app)
      .get("/api/v1/account/token")
      .set("Cookie", register.headers["set-cookie"][0]);

    const response = await request(app)
      .post("/api/v1/document/")
      .set("Authorization", `Bearer ${token.body.token}`)
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

    const register = await request(app).post("/api/v1/auth/register").send({
      email: "document-edit@example.com",
      password: "verysecurepassword",
    });
    const token = await request(app)
      .get("/api/v1/account/token")
      .set("Cookie", register.headers["set-cookie"][0]);

    const createResponse = await request(app)
      .post("/api/v1/document/")
      .set("Authorization", `Bearer ${token.body.token}`)
      .send({
        title: "Original title",
        content: "Original content",
      });

    const getResponse = await request(app)
      .get(`/api/v1/document/${createResponse.body.documentId}`)
      .set("Authorization", `Bearer ${token.body.token}`);

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
      .set("Authorization", `Bearer ${token.body.token}`)
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
      .set("Authorization", `Bearer ${token.body.token}`);

    expect(reprocessResponse.status).toBe(202);
    expect(reprocessResponse.body).toMatchObject({
      documentId: createResponse.body.documentId,
      status: "queued",
    });

    const listResponse = await request(app)
      .get("/api/v1/document/")
      .set("Authorization", `Bearer ${token.body.token}`);

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

    const register = await request(app).post("/api/v1/auth/register").send({
      email: "document-delete@example.com",
      password: "verysecurepassword",
    });
    const token = await request(app)
      .get("/api/v1/account/token")
      .set("Cookie", register.headers["set-cookie"][0]);

    const createResponse = await request(app)
      .post("/api/v1/document/")
      .set("Authorization", `Bearer ${token.body.token}`)
      .send({
        title: "Disposable title",
        content: "Disposable content",
      });

    const deleteResponse = await request(app)
      .delete(`/api/v1/document/${createResponse.body.documentId}`)
      .set("Authorization", `Bearer ${token.body.token}`);

    expect(deleteResponse.status).toBe(204);
    expect(deleteResponse.body).toEqual({});

    const listResponse = await request(app)
      .get("/api/v1/document/")
      .set("Authorization", `Bearer ${token.body.token}`);

    expect(listResponse.status).toBe(200);
    expect(listResponse.body.documents).toEqual([]);
  });

  it("returns not_found when deleting a document outside the authenticated account", async () => {
    const { app } = createTestApp();

    const ownerRegister = await request(app).post("/api/v1/auth/register").send({
      email: "document-delete-owner@example.com",
      password: "verysecurepassword",
    });
    const ownerToken = await request(app)
      .get("/api/v1/account/token")
      .set("Cookie", ownerRegister.headers["set-cookie"][0]);

    const intruderRegister = await request(app).post("/api/v1/auth/register").send({
      email: "document-delete-intruder@example.com",
      password: "verysecurepassword",
    });
    const intruderToken = await request(app)
      .get("/api/v1/account/token")
      .set("Cookie", intruderRegister.headers["set-cookie"][0]);

    const createResponse = await request(app)
      .post("/api/v1/document/")
      .set("Authorization", `Bearer ${ownerToken.body.token}`)
      .send({
        title: "Protected title",
        content: "Protected content",
      });

    const deleteResponse = await request(app)
      .delete(`/api/v1/document/${createResponse.body.documentId}`)
      .set("Authorization", `Bearer ${intruderToken.body.token}`);

    expect(deleteResponse.status).toBe(404);
    expect(deleteResponse.body).toMatchObject({
      error: {
        code: "not_found",
        message: "Document not found",
      },
    });
  });
});
