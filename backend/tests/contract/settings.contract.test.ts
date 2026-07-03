import { readFileSync } from "node:fs";

import request from "supertest";
import { describe, expect, it } from "vitest";

import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

describe("settings contract", () => {
  it("returns assistant and channel settings through one shared resource", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "platform-settings-default@example.com");

    const response = await request(app)
      .get("/api/v1/settings")
      .set(adminSessionHeaders(session));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      assistant: {
        assistantName: "",
        greetingInstruction: "",
        assistantDefaultLocale: null,
        proactiveGreetingEnabled: false,
        assistantBootstrapActive: false,
        suggestedQuestionsEnabled: true,
        customInstruction: "",
      },
      channels: {
        anonymousChatEnabled: false,
        anonymousChatUrl: null,
        websiteEmbedEnabled: false,
        websiteEmbedAllowedOrigins: [],
        websiteEmbedLauncherLabel: expect.any(String),
        websiteEmbedLauncherPosition: expect.any(String),
        websiteEmbedScriptUrl: null,
        websiteEmbedSnippet: null,
      },
    });
    expect(response.body).not.toHaveProperty("retrieval");
  });

  it("merge-updates shared settings without resetting omitted sections", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "platform-settings-merge@example.com");

    const assistantUpdate = await request(app)
      .put("/api/v1/settings")
      .set(adminSessionHeaders(session))
      .send({
        assistant: {
          assistantName: "Marta",
          customInstruction: "Answer plainly.",
        },
      });

    const channelsUpdate = await request(app)
      .put("/api/v1/settings")
      .set(adminSessionHeaders(session))
      .send({
        channels: {
          anonymousChatEnabled: true,
        },
      });

    expect(assistantUpdate.status).toBe(200);
    expect(channelsUpdate.status).toBe(200);
    expect(channelsUpdate.body).toMatchObject({
      assistant: {
        assistantName: "Marta",
        customInstruction: "Answer plainly.",
      },
      channels: {
        anonymousChatEnabled: true,
        anonymousChatUrl: expect.any(String),
      },
    });
    expect(channelsUpdate.body).not.toHaveProperty("retrieval");
  });

  it("does not expose workspace retrieval settings endpoints", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "settings-default@example.com");

    const getResponse = await request(app)
      .get("/api/v1/settings/retrieval")
      .set(adminSessionHeaders(session));
    const putResponse = await request(app)
      .put("/api/v1/settings/retrieval")
      .set(adminSessionHeaders(session))
      .send({
        queryRewriteEnabled: true,
      });

    expect(getResponse.status).toBe(404);
    expect(putResponse.status).toBe(404);
  });

  it("returns retrieval defaults with metadata field suggestions on the dedicated endpoint", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "settings-retrieval-defaults@example.com");

    await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({
        title: "Metadata policy doc",
        content: "Metadata rich content",
        metadata: {
          language: "en",
          publishedAt: "2026-06-08",
        },
      },
    );

    const response = await request(app)
      .get("/api/v1/settings/retrieval-defaults")
      .set(adminSessionHeaders(session));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      queryRewriteEnabled: true,
      suggestedQuestionsEnabled: true,
      suggestedQuestionsCount: 3,
      rerankEnabled: false,
      vectorTopK: 15,
      rerankTopK: 5,
      retrievalStrategy: "fixed",
      customInstruction: "",
      metadataRules: [],
    });
    expect(response.body).not.toHaveProperty("workspaceId");
    expect(response.body).not.toHaveProperty("similarityThreshold");
    expect(response.body).not.toHaveProperty("createdAt");
    expect(response.body).not.toHaveProperty("updatedAt");
    expect(response.body.metadataFieldSuggestions).toEqual(
      expect.arrayContaining([
        { field: "language", inferredType: "string" },
        { field: "publishedAt", inferredType: "date" },
      ]),
    );
  });

  it("returns default ingestion settings for a valid session workspace context", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "ingestion-default@example.com");

    const response = await request(app)
      .get("/api/v1/settings/ingestion")
      .set(adminSessionHeaders(session));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      chunkingStrategy: "fixed_window",
      embeddingModel: "text-embedding-3-small",
      pendingEmbeddingModel: null,
      fixedWindowChunkSize: 800,
      fixedWindowChunkOverlap: 120,
      structuredMinChunkSize: 24,
      structuredMaxChunkSize: 220,
    });
  });

  it("updates ingestion settings for a valid session workspace context", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "ingestion-update@example.com");

    const response = await request(app)
      .put("/api/v1/settings/ingestion")
      .set(adminSessionHeaders(session))
      .send({
        chunkingStrategy: "structured_semantic",
        fixedWindowChunkSize: 900,
        fixedWindowChunkOverlap: 90,
        structuredMinChunkSize: 30,
        structuredMaxChunkSize: 260,
        embeddingModel: "text-embedding-3-large",
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      chunkingStrategy: "structured_semantic",
      embeddingModel: "text-embedding-3-large",
      pendingEmbeddingModel: null,
      fixedWindowChunkSize: 900,
      fixedWindowChunkOverlap: 90,
      structuredMinChunkSize: 30,
      structuredMaxChunkSize: 260,
      supportedEmbeddingModels: expect.arrayContaining(["text-embedding-3-small", "text-embedding-3-large"]),
    });
  });

  it("keeps the active embedding model until existing documents are reprocessed", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "ingestion-model-migration@example.com");

    await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({
        title: "Existing",
        content: "Already embedded content",
      });

    const response = await request(app)
      .put("/api/v1/settings/ingestion")
      .set(adminSessionHeaders(session))
      .send({
        chunkingStrategy: "fixed_window",
        fixedWindowChunkSize: 800,
        fixedWindowChunkOverlap: 120,
        structuredMinChunkSize: 24,
        structuredMaxChunkSize: 220,
        embeddingModel: "text-embedding-3-large",
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      embeddingModel: "text-embedding-3-small",
      pendingEmbeddingModel: "text-embedding-3-large",
    });
  });

  it("starts workspace ingestion reprocessing for a valid session workspace context", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "ingestion-reprocess@example.com");

    await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({ title: "Guide", content: "Queued for reprocess." });

    const response = await request(app)
      .post("/api/v1/settings/ingestion/reprocess")
      .set(adminSessionHeaders(session));

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      workspaceId: expect.any(String),
      queuedDocumentCount: 1,
      skippedDocumentCount: 0,
      status: "queued",
    });
  });

  it("documents retrieval defaults and ingestion settings in the generated schema", () => {
    const spec = readFileSync(new URL("../../openapi.yaml", import.meta.url), "utf8");
    const retrievalDefaultsSchema = spec.match(/RetrievalDefaultsResponse:\n([\s\S]*?)\n    RetrievalSettingsOverride:/)?.[1] ?? "";
    const retrievalOverrideSchema = spec.match(/RetrievalSettingsOverride:\n([\s\S]*?)\n    IngestionSettings:/)?.[1] ?? "";
    const ingestionSettingsSchema = spec.match(/IngestionSettings:\n([\s\S]*?)\n    UpdateIngestionSettingsRequest:/)?.[1] ?? "";
    const ingestionUpdateSchema = spec.match(/UpdateIngestionSettingsRequest:\n([\s\S]*?)\n    RetrievalMetadataRule:/)?.[1] ?? "";

    expect(spec).not.toContain("/api/v1/settings/retrieval:");
    expect(spec).not.toContain("UpdateRetrievalSettingsRequest:");
    expect(spec).not.toContain("/api/v1/settings/metadata-fields:");
    expect(retrievalDefaultsSchema).toContain("queryRewriteEnabled:");
    expect(retrievalDefaultsSchema).toContain("semanticRewriteInstructions:");
    expect(retrievalDefaultsSchema).toContain("lexicalRewriteInstructions:");
    expect(retrievalDefaultsSchema).toContain("suggestedQuestionsEnabled:");
    expect(retrievalDefaultsSchema).toContain("suggestedQuestionsCount:");
    expect(retrievalDefaultsSchema).toContain("rerankEnabled:");
    expect(retrievalDefaultsSchema).toContain("vectorTopK:");
    expect(retrievalDefaultsSchema).toContain("rerankTopK:");
    expect(retrievalDefaultsSchema).toContain("retrievalStrategy:");
    expect(retrievalDefaultsSchema).toContain("customInstruction:");
    expect(retrievalDefaultsSchema).toContain("metadataRules:");
    expect(retrievalDefaultsSchema).toContain("metadataFieldSuggestions:");
    expect(retrievalDefaultsSchema).not.toContain("workspaceId:");
    expect(retrievalDefaultsSchema).not.toContain("similarityThreshold:");
    expect(retrievalOverrideSchema).toContain("metadataRules:");
    expect(retrievalOverrideSchema).toContain("semanticRewriteInstructions:");
    expect(retrievalOverrideSchema).toContain("suggestedQuestionsEnabled:");
    expect(retrievalOverrideSchema).toContain("lexicalRewriteInstructions:");
    expect(retrievalOverrideSchema).not.toContain("chunkingStrategy:");
    expect(ingestionSettingsSchema).toContain("chunkingStrategy:");
    expect(ingestionSettingsSchema).toContain("embeddingModel:");
    expect(ingestionSettingsSchema).toContain("pendingEmbeddingModel:");
    expect(ingestionSettingsSchema).toContain("fixedWindowChunkSize:");
    expect(ingestionUpdateSchema).toContain("embeddingModel:");
    expect(ingestionUpdateSchema).toContain("fixedWindowChunkOverlap:");
    expect(ingestionUpdateSchema).toContain("structuredMinChunkSize:");
    expect(spec).toContain("/api/v1/settings:");
    expect(spec).toContain("/api/v1/settings/retrieval-defaults:");
    expect(spec).toContain("PlatformSettingsResponse:");
    expect(spec).toContain("UpdatePlatformSettingsRequest:");
    expect(spec).toContain("/api/v1/settings/ingestion:");
    expect(spec).toContain("/api/v1/settings/ingestion/reprocess:");
  });
});
