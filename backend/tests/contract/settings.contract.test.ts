import { readFileSync } from "node:fs";

import request from "supertest";
import { describe, expect, it } from "vitest";

import { createTestApp } from "../support/testApp.js";

const issueToken = async (app: ReturnType<typeof createTestApp>["app"]) => {
  const register = await request(app).post("/api/v1/auth/register").send({
    email: "settings@example.com",
    password: "verysecurepassword",
  });
  const cookie = register.headers["set-cookie"][0];

  const workspaces = await request(app)
    .get("/api/v1/workspace")
    .set("Cookie", cookie);
  const workspaceId = workspaces.body.workspaces[0].id;

  const token = await request(app)
    .get(`/api/v1/account/workspaces/${workspaceId}/token`)
    .set("Cookie", cookie);

  return token.body.token as string;
};

describe("settings contract", () => {
  it("returns default retrieval settings for a valid bearer token", async () => {
    const { app } = createTestApp();
    const token = await issueToken(app);

    const response = await request(app)
      .get("/api/v1/settings/retrieval")
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(Object.keys(response.body).sort()).toEqual([
      "attributeControls",
      "citationDisplayEnabled",
      "createdAt",
      "customInstruction",
      "queryRewriteEnabled",
      "rerankEnabled",
      "rerankTopK",
      "similarityThreshold",
      "updatedAt",
      "vectorTopK",
      "warmthLevel",
      "workspaceId",
    ]);
    expect(response.body.vectorTopK).toBe(15);
    expect(response.body.warmthLevel).toBe(5);
    expect(response.body.citationDisplayEnabled).toBe(true);
    expect(response.body.customInstruction).toBe("");
    expect(response.body.attributeControls).toEqual([
      { family: "date_point", enabled: true, mode: "boost_only" },
      { family: "date_range", enabled: true, mode: "boost_only" },
      { family: "money_value", enabled: true, mode: "boost_only" },
      { family: "location", enabled: true, mode: "boost_only" },
    ]);
  });

  it("updates retrieval settings for a valid bearer token", async () => {
    const { app } = createTestApp();
    const token = await issueToken(app);

    const response = await request(app)
      .put("/api/v1/settings/retrieval")
      .set("Authorization", `Bearer ${token}`)
      .send({
        queryRewriteEnabled: true,
        rerankEnabled: true,
        vectorTopK: 12,
        similarityThreshold: 0.4,
        rerankTopK: 6,
        warmthLevel: 8,
        citationDisplayEnabled: false,
        customInstruction: "Always cite the paragraph number from the Immigration Act.",
        attributeControls: [
          { family: "date_point", enabled: true, mode: "hard_filter" },
          { family: "date_range", enabled: true, mode: "boost_only" },
          { family: "money_value", enabled: false, mode: "boost_only" },
          { family: "location", enabled: true, mode: "boost_only" },
        ],
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      queryRewriteEnabled: true,
      rerankEnabled: true,
      vectorTopK: 12,
      similarityThreshold: 0.4,
      rerankTopK: 6,
      warmthLevel: 8,
      citationDisplayEnabled: false,
      customInstruction: "Always cite the paragraph number from the Immigration Act.",
      attributeControls: [
        { family: "date_point", enabled: true, mode: "hard_filter" },
        { family: "date_range", enabled: true, mode: "boost_only" },
        { family: "money_value", enabled: false, mode: "boost_only" },
        { family: "location", enabled: true, mode: "boost_only" },
      ],
    });
  });

  it("preserves saved attribute controls when an older client omits the field", async () => {
    const { app } = createTestApp();
    const token = await issueToken(app);
    const authorization = `Bearer ${token}`;

    const firstUpdate = await request(app)
      .put("/api/v1/settings/retrieval")
      .set("Authorization", authorization)
      .send({
        queryRewriteEnabled: true,
        rerankEnabled: true,
        vectorTopK: 12,
        similarityThreshold: 0.4,
        rerankTopK: 6,
        warmthLevel: 8,
        citationDisplayEnabled: false,
        customInstruction: "Cite paragraph numbers.",
        attributeControls: [
          { family: "date_point", enabled: true, mode: "hard_filter" },
          { family: "date_range", enabled: false, mode: "boost_only" },
          { family: "money_value", enabled: false, mode: "boost_only" },
          { family: "location", enabled: true, mode: "boost_only" },
        ],
      });

    const secondUpdate = await request(app)
      .put("/api/v1/settings/retrieval")
      .set("Authorization", authorization)
      .send({
        queryRewriteEnabled: false,
        rerankEnabled: false,
        vectorTopK: 20,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        warmthLevel: 5,
        citationDisplayEnabled: true,
      });

    expect(firstUpdate.status).toBe(200);
    expect(secondUpdate.status).toBe(200);
    expect(secondUpdate.body.attributeControls).toEqual(firstUpdate.body.attributeControls);
    expect(secondUpdate.body.customInstruction).toBe("Cite paragraph numbers.");
  });

  it("returns default ingestion settings for a valid bearer token", async () => {
    const { app } = createTestApp();
    const token = await issueToken(app);

    const response = await request(app)
      .get("/api/v1/settings/ingestion")
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      chunkingStrategy: "fixed_window",
      fixedWindowChunkSize: 800,
      fixedWindowChunkOverlap: 120,
      structuredMinChunkSize: 24,
      structuredMaxChunkSize: 220,
    });
  });

  it("updates ingestion settings for a valid bearer token", async () => {
    const { app } = createTestApp();
    const token = await issueToken(app);

    const response = await request(app)
      .put("/api/v1/settings/ingestion")
      .set("Authorization", `Bearer ${token}`)
      .send({
        chunkingStrategy: "structured_semantic",
        fixedWindowChunkSize: 900,
        fixedWindowChunkOverlap: 90,
        structuredMinChunkSize: 30,
        structuredMaxChunkSize: 260,
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      chunkingStrategy: "structured_semantic",
      fixedWindowChunkSize: 900,
      fixedWindowChunkOverlap: 90,
      structuredMinChunkSize: 30,
      structuredMaxChunkSize: 260,
    });
  });

  it("starts workspace ingestion reprocessing for a valid bearer token", async () => {
    const { app } = createTestApp();
    const token = await issueToken(app);
    const authorization = `Bearer ${token}`;

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({ title: "Guide", content: "Queued for reprocess." });

    const response = await request(app)
      .post("/api/v1/settings/ingestion/reprocess")
      .set("Authorization", authorization);

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      workspaceId: expect.any(String),
      queuedDocumentCount: 1,
      skippedDocumentCount: 0,
      status: "queued",
    });
  });

  it("documents the retrieval and ingestion settings split in the generated schema", () => {
    const spec = readFileSync(new URL("../../openapi.yaml", import.meta.url), "utf8");
    const retrievalSettingsSchema = spec.match(/RetrievalSettings:\n([\s\S]*?)\n    UpdateRetrievalSettingsRequest:/)?.[1] ?? "";
    const retrievalUpdateSchema = spec.match(/UpdateRetrievalSettingsRequest:\n([\s\S]*?)\n    IngestionSettings:/)?.[1] ?? "";
    const ingestionSettingsSchema = spec.match(/IngestionSettings:\n([\s\S]*?)\n    UpdateIngestionSettingsRequest:/)?.[1] ?? "";
    const ingestionUpdateSchema = spec.match(/UpdateIngestionSettingsRequest:\n([\s\S]*?)\n    AttributeFamilyControl:/)?.[1] ?? "";

    expect(retrievalSettingsSchema).not.toContain("chunkingStrategy:");
    expect(retrievalUpdateSchema).toContain("attributeControls:");
    expect(retrievalUpdateSchema).not.toContain("chunkingStrategy:");
    expect(ingestionSettingsSchema).toContain("chunkingStrategy:");
    expect(ingestionSettingsSchema).toContain("fixedWindowChunkSize:");
    expect(ingestionUpdateSchema).toContain("fixedWindowChunkOverlap:");
    expect(ingestionUpdateSchema).toContain("structuredMinChunkSize:");
    expect(spec).toContain("/api/v1/settings/ingestion:");
    expect(spec).toContain("/api/v1/settings/ingestion/reprocess:");
  });
});
