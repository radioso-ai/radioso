import request from "supertest";
import { describe, expect, it } from "vitest";

import { createTestApp } from "../support/testApp.js";

describe("document contract", () => {
  it("creates a document for a bearer-authenticated account", async () => {
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

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      documentId: expect.any(String),
      status: "ready",
    });
  });

  it("returns and updates a document for a bearer-authenticated account", async () => {
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
      status: "ready",
      ragStatus: "processed",
    });

    const updateResponse = await request(app)
      .put(`/api/v1/document/${createResponse.body.documentId}`)
      .set("Authorization", `Bearer ${token.body.token}`)
      .send({
        title: "Updated title",
        content: "Updated content",
      });

    expect(updateResponse.status).toBe(200);
    expect(updateResponse.body).toMatchObject({
      documentId: createResponse.body.documentId,
      status: "ready",
    });

    const listResponse = await request(app)
      .get("/api/v1/document/")
      .set("Authorization", `Bearer ${token.body.token}`);

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
});
