import request from "supertest";
import { describe, expect, it } from "vitest";

import { createTestApp } from "../support/testApp.js";
import { defaultAttributeControls } from "../../src/modules/settings/domain/retrievalSettings.js";

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
        warmthLevel: 5,
        citationDisplayEnabled: true,
        chunkingStrategy: "fixed_window",
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

  it("updates settings and accepts a document for async processing for the same account", async () => {
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
        warmthLevel: 5,
        citationDisplayEnabled: true,
        chunkingStrategy: "structured_semantic",
      });
    const document = await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({
        title: "Doc",
        content: "This is a content to be parsed. ".repeat(40),
      });

    expect(settings.status).toBe(200);
    expect(settings.body.chunkingStrategy).toBe("structured_semantic");
    expect(document.status).toBe(202);
    expect(document.body.status).toBe("queued");
  });

  it("keeps attribute-family controls account scoped", async () => {
    const { app } = createTestApp();

    const firstRegister = await request(app).post("/api/v1/auth/register").send({
      email: "controls-one@example.com",
      password: "verysecurepassword",
    });
    const secondRegister = await request(app).post("/api/v1/auth/register").send({
      email: "controls-two@example.com",
      password: "verysecurepassword",
    });

    const firstToken = await request(app)
      .get("/api/v1/account/token")
      .set("Cookie", firstRegister.headers["set-cookie"][0]);
    const secondToken = await request(app)
      .get("/api/v1/account/token")
      .set("Cookie", secondRegister.headers["set-cookie"][0]);

    const firstAuthorization = `Bearer ${firstToken.body.token}`;
    const secondAuthorization = `Bearer ${secondToken.body.token}`;

    const firstUpdate = await request(app)
      .put("/api/v1/settings/retrieval")
      .set("Authorization", firstAuthorization)
      .send({
        queryRewriteEnabled: true,
        rerankEnabled: true,
        vectorTopK: 25,
        similarityThreshold: 0.25,
        rerankTopK: 8,
        warmthLevel: 6,
        citationDisplayEnabled: true,
        chunkingStrategy: "structured_semantic",
        attributeControls: defaultAttributeControls().map((control) =>
          control.family === "location"
            ? { ...control, enabled: false }
            : control.family === "money_value"
              ? { ...control, mode: "hard_filter" as const }
              : control,
        ),
      });

    const secondSettings = await request(app)
      .get("/api/v1/settings/retrieval")
      .set("Authorization", secondAuthorization);

    expect(firstUpdate.status).toBe(200);
    expect(firstUpdate.body.attributeControls).toContainEqual({
      family: "location",
      enabled: false,
      mode: "boost_only",
    });
    expect(firstUpdate.body.attributeControls).toContainEqual({
      family: "money_value",
      enabled: true,
      mode: "hard_filter",
    });
    expect(secondSettings.status).toBe(200);
    expect(secondSettings.body.attributeControls).toEqual(defaultAttributeControls());
  });
});
