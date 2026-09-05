import { readFileSync } from "node:fs";

import request from "supertest";
import { describe, expect, it } from "vitest";

import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";
import { defaultIngestionSettings } from "../../src/modules/settings/domain/ingestionSettings.js";

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
      temporalStructuredLookupEnabled: true,
      temporalBoostUpcomingEnabled: true,
      temporalDeterministicSortEnabled: true,
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

  it("suggests declared catalog fields alongside observed document metadata keys", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "settings-suggestion-union@example.com");
    const headers = adminSessionHeaders(session);

    await request(app)
      .post("/api/v1/document/")
      .set(headers)
      .send({
        title: "Hand-tagged doc",
        content: "Content with a manually authored tag.",
        // A hand-set key the catalog never declares, and a key the catalog also
        // declares under a different type — the catalog wins that one.
        metadata: { language: "en", price: "49" },
      });

    await request(app)
      .put("/api/v1/settings/document-types")
      .set(headers)
      .send({
        expectedRevision: "1",
        types: [
          {
            key: "product",
            label: "Product",
            description: "A product detail page.",
            enabled: true,
            fields: [
              { key: "price", label: "Price", valueType: "number", instruction: "The listed price." },
              { key: "category", label: "Category", valueType: "string", instruction: "The product category." },
            ],
          },
        ],
        disabledBuiltInTypeKeys: [],
      });

    const response = await request(app)
      .get("/api/v1/settings/retrieval-defaults")
      .set(headers);

    expect(response.status).toBe(200);
    const suggestions = response.body.metadataFieldSuggestions as Array<{ field: string; inferredType: string }>;
    expect(suggestions).toEqual(
      expect.arrayContaining([
        { field: "language", inferredType: "string" },
        { field: "category", inferredType: "string" },
        { field: "dateFrom", inferredType: "date" },
        { field: "dateTo", inferredType: "date" },
      ]),
    );
    // The declared value type wins over the type inferred from a hand-set value.
    expect(suggestions.filter((suggestion) => suggestion.field === "price")).toEqual([
      { field: "price", inferredType: "number" },
    ]);
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
      documentEnrichmentEnabled: false,
      manualDocumentEnrichmentOverride: "inherit",
    });
  });

  it("round-trips the manually added document enrichment override", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "ingestion-manual-override@example.com");

    const updateResponse = await request(app)
      .put("/api/v1/settings/ingestion")
      .set(adminSessionHeaders(session))
      .send({
        chunkingStrategy: "fixed_window",
        fixedWindowChunkSize: 800,
        fixedWindowChunkOverlap: 120,
        structuredMinChunkSize: 24,
        structuredMaxChunkSize: 220,
        manualDocumentEnrichmentOverride: "on",
      })
      .expect(200);

    expect(updateResponse.body).toMatchObject({ manualDocumentEnrichmentOverride: "on" });

    const readResponse = await request(app)
      .get("/api/v1/settings/ingestion")
      .set(adminSessionHeaders(session))
      .expect(200);

    expect(readResponse.body).toMatchObject({ manualDocumentEnrichmentOverride: "on" });

    await request(app)
      .put("/api/v1/settings/ingestion")
      .set(adminSessionHeaders(session))
      .send({
        chunkingStrategy: "fixed_window",
        fixedWindowChunkSize: 800,
        fixedWindowChunkOverlap: 120,
        structuredMinChunkSize: 24,
        structuredMaxChunkSize: 220,
        manualDocumentEnrichmentOverride: "sometimes",
      })
      .expect(400);
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
        documentEnrichmentEnabled: true,
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
      documentEnrichmentEnabled: true,
      supportedEmbeddingModels: [
        "text-embedding-3-small",
        "text-embedding-3-large",
        "text-embedding-ada-002",
        "gemini-embedding-001",
      ],
    });
  });

  it("accepts an unchanged legacy model echo but rejects another unsupported model", async () => {
    const { app, repositories } = createTestApp();
    const session = await issueTestSession(app, "ingestion-legacy-echo@example.com");
    const legacyModel = "legacy-compatible-embedding";
    await repositories.ingestionSettingsRepository.upsert(
      session.workspaceId,
      {
        ...defaultIngestionSettings(session.workspaceId),
        embeddingModel: legacyModel,
      } as never,
    );
    const baseUpdate = {
      chunkingStrategy: "structured_semantic",
      fixedWindowChunkSize: 800,
      fixedWindowChunkOverlap: 120,
      structuredMinChunkSize: 24,
      structuredMaxChunkSize: 220,
      documentEnrichmentEnabled: true,
    };

    const unchanged = await request(app)
      .put("/api/v1/settings/ingestion")
      .set(adminSessionHeaders(session))
      .send({ ...baseUpdate, embeddingModel: legacyModel });
    const rejected = await request(app)
      .put("/api/v1/settings/ingestion")
      .set(adminSessionHeaders(session))
      .send({
        ...baseUpdate,
        embeddingModel: "different-unsupported-model",
      });
    const persisted =
      await repositories.ingestionSettingsRepository.findByWorkspaceId(
        session.workspaceId,
      );

    expect(unchanged.status).toBe(200);
    expect(unchanged.body).toMatchObject({
      embeddingModel: legacyModel,
      pendingEmbeddingModel: null,
      documentEnrichmentEnabled: true,
      supportedEmbeddingModels: [
        "text-embedding-3-small",
        "text-embedding-3-large",
        "text-embedding-ada-002",
        "gemini-embedding-001",
      ],
    });
    expect(rejected.status).toBe(400);
    expect(persisted).toMatchObject({
      embeddingModel: legacyModel,
      pendingEmbeddingModel: null,
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
      .set(adminSessionHeaders(session))
      .send({ documentEnrichmentOverride: "on" });

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
    const retrievalDefaultsSchema = spec.match(/RetrievalDefaultsResponse:\n([\s\S]*?)\n {4}RetrievalSettingsOverride:/)?.[1] ?? "";
    const retrievalOverrideSchema = spec.match(/RetrievalSettingsOverride:\n([\s\S]*?)\n {4}IngestionSettings:/)?.[1] ?? "";
    const ingestionSettingsSchema = spec.match(/IngestionSettings:\n([\s\S]*?)\n {4}UpdateIngestionSettingsRequest:/)?.[1] ?? "";
    const ingestionUpdateSchema = spec.match(/UpdateIngestionSettingsRequest:\n([\s\S]*?)\n {4}RetrievalMetadataRule:/)?.[1] ?? "";

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
    expect(retrievalDefaultsSchema).toContain("temporalStructuredLookupEnabled:");
    expect(retrievalDefaultsSchema).toContain("temporalBoostUpcomingEnabled:");
    expect(retrievalDefaultsSchema).toContain("temporalDeterministicSortEnabled:");
    expect(retrievalDefaultsSchema).not.toContain("workspaceId:");
    expect(retrievalDefaultsSchema).not.toContain("similarityThreshold:");
    expect(retrievalOverrideSchema).toContain("metadataRules:");
    expect(retrievalOverrideSchema).toContain("semanticRewriteInstructions:");
    expect(retrievalOverrideSchema).toContain("suggestedQuestionsEnabled:");
    expect(retrievalOverrideSchema).toContain("lexicalRewriteInstructions:");
    expect(retrievalOverrideSchema).toContain("temporalStructuredLookupEnabled:");
    expect(retrievalOverrideSchema).toContain("temporalBoostUpcomingEnabled:");
    expect(retrievalOverrideSchema).toContain("temporalDeterministicSortEnabled:");
    expect(retrievalOverrideSchema).not.toContain("chunkingStrategy:");
    expect(ingestionSettingsSchema).toContain("chunkingStrategy:");
    expect(ingestionSettingsSchema).toContain("embeddingModel:");
    expect(ingestionSettingsSchema).toContain("pendingEmbeddingModel:");
    const ingestionResponseModelSchema =
      ingestionSettingsSchema.match(
        /embeddingModel:\n([\s\S]*?)\n {8}pendingEmbeddingModel:/,
      )?.[1] ?? "";
    const ingestionUpdateModelSchema =
      ingestionUpdateSchema.match(
        /embeddingModel:\n([\s\S]*?)\n {8}documentEnrichmentEnabled:/,
      )?.[1] ?? "";
    expect(ingestionResponseModelSchema).toContain("type: string");
    expect(ingestionResponseModelSchema).not.toContain("enum:");
    expect(ingestionUpdateModelSchema).toContain("enum:");
    expect(ingestionSettingsSchema).toContain("fixedWindowChunkSize:");
    expect(ingestionSettingsSchema).toContain("documentEnrichmentEnabled:");
    expect(ingestionSettingsSchema).toContain("manualDocumentEnrichmentOverride:");
    expect(ingestionUpdateSchema).toContain("manualDocumentEnrichmentOverride:");
    expect(ingestionUpdateSchema).toContain("embeddingModel:");
    expect(ingestionUpdateSchema).toContain("fixedWindowChunkOverlap:");
    expect(ingestionUpdateSchema).toContain("structuredMinChunkSize:");
    expect(ingestionUpdateSchema).toContain("documentEnrichmentEnabled:");
    expect(spec).toContain("ReprocessIngestionRequest:");
    expect(spec).toContain("documentEnrichmentOverride:");
    expect(spec).toContain("/api/v1/settings:");
    expect(spec).toContain("/api/v1/settings/retrieval-defaults:");
    expect(spec).toContain("PlatformSettingsResponse:");
    expect(spec).toContain("UpdatePlatformSettingsRequest:");
    expect(spec).toContain("/api/v1/settings/ingestion:");
    expect(spec).toContain("/api/v1/settings/ingestion/reprocess:");
  });
});
