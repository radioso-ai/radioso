import request from "supertest";
import { describe, expect, it } from "vitest";

import { createTestApp } from "../support/testApp.js";

describe("document and settings integration", () => {
  it("rejects invalid settings payloads", async () => {
    const { app } = createTestApp();

    const register = await request(app).post("/api/v1/auth/register").send({
      email: "invalid-settings@example.com",
      password: "verysecurepassword",
    });
    const token = await request(app)
      .get("/api/v1/account/token")
      .set("Cookie", register.headers["set-cookie"][0]);

    const response = await request(app)
      .put("/api/v1/settings/retrieval")
      .set("Authorization", `Bearer ${token.body.token}`)
      .send({
        queryRewriteEnabled: false,
        rerankEnabled: false,
        vectorTopK: 0,
        similarityThreshold: 0.2,
        rerankTopK: 5,
      });

    expect(response.status).toBe(400);
  });

  it("rejects document ingestion without a bearer token", async () => {
    const { app } = createTestApp();

    const response = await request(app).post("/api/v1/document/").send({
      title: "Missing auth",
      content: "No token present",
    });

    expect(response.status).toBe(401);
  });

  it("updates settings and ingests a document for the same account", async () => {
    const { app } = createTestApp();

    const register = await request(app).post("/api/v1/auth/register").send({
      email: "workflow@example.com",
      password: "verysecurepassword",
    });
    const token = await request(app)
      .get("/api/v1/account/token")
      .set("Cookie", register.headers["set-cookie"][0]);
    const authorization = `Bearer ${token.body.token}`;

    const settings = await request(app)
      .put("/api/v1/settings/retrieval")
      .set("Authorization", authorization)
      .send({
        queryRewriteEnabled: true,
        rerankEnabled: false,
        vectorTopK: 20,
        similarityThreshold: 0.35,
        rerankTopK: 5,
      });
    const document = await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({
        title: "Doc",
        content: "This is a content to be parsed. ".repeat(40),
      });

    expect(settings.status).toBe(200);
    expect(document.status).toBe(201);
  });
});
