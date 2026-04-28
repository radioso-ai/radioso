import { readFileSync } from "node:fs";

import request from "supertest";
import { describe, expect, it } from "vitest";

import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

describe("settings contract", () => {
  it("returns assistant, retrieval, and channel settings through one shared resource", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "platform-settings-default@example.com");

    const response = await request(app)
      .get("/api/v1/settings")
      .set(adminSessionHeaders(session));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      assistant: {
        assistantName: "",
        assistantRole: "",
        greetingInstruction: "",
        assistantDefaultLocale: null,
        proactiveGreetingEnabled: false,
        assistantBootstrapActive: false,
        conversationMode: "guided",
        suggestedQuestionsEnabled: true,
        suggestedQuestionsCount: 3,
        customInstruction: "",
      },
      retrieval: {
        queryRewriteEnabled: false,
        semanticRewriteInstructions: expect.any(String),
        lexicalRewriteInstructions: expect.any(String),
        rerankEnabled: false,
        vectorTopK: 15,
        similarityThreshold: expect.any(Number),
        rerankTopK: 5,
        citationDisplayEnabled: true,
        answerSupportValidationEnabled: true,
        metadataRules: [],
        metadataFieldSuggestions: [],
      },
      channels: {
        anonymousChatEnabled: false,
        anonymousChatUrl: null,
        anonymousRateLimit: 10,
        websiteEmbedEnabled: false,
        websiteEmbedAllowedOrigins: [],
        websiteEmbedLauncherLabel: expect.any(String),
        websiteEmbedLauncherIcon: expect.any(String),
        websiteEmbedLauncherPosition: expect.any(String),
        websiteEmbedScriptUrl: "http://localhost:3000/radioso-embed.js",
        websiteEmbedSnippet: null,
      },
    });
    expect(response.body.retrieval).not.toHaveProperty("conversationMode");
    expect(response.body.retrieval).not.toHaveProperty("customInstruction");
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
          conversationMode: "exploratory",
          customInstruction: "Answer plainly.",
        },
      });

    const retrievalUpdate = await request(app)
      .put("/api/v1/settings")
      .set(adminSessionHeaders(session))
      .send({
        retrieval: {
          queryRewriteEnabled: true,
          vectorTopK: 12,
          rerankEnabled: true,
        },
      });

    const channelsUpdate = await request(app)
      .put("/api/v1/settings")
      .set(adminSessionHeaders(session))
      .send({
        channels: {
          anonymousChatEnabled: true,
          anonymousRateLimit: 20,
        },
      });

    expect(assistantUpdate.status).toBe(200);
    expect(retrievalUpdate.status).toBe(200);
    expect(channelsUpdate.status).toBe(200);
    expect(channelsUpdate.body).toMatchObject({
      assistant: {
        assistantName: "Marta",
        conversationMode: "exploratory",
        customInstruction: "Answer plainly.",
      },
      retrieval: {
        queryRewriteEnabled: true,
        vectorTopK: 12,
        rerankEnabled: true,
      },
      channels: {
        anonymousChatEnabled: true,
        anonymousRateLimit: 20,
        anonymousChatUrl: expect.any(String),
      },
    });
  });

  it("returns default retrieval settings for a valid session workspace context", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "settings-default@example.com");

    const response = await request(app)
      .get("/api/v1/settings/retrieval")
      .set(adminSessionHeaders(session));

    expect(response.status).toBe(200);
    expect(Object.keys(response.body).sort()).toEqual([
      "answerSupportValidationEnabled",
      "citationDisplayEnabled",
      "conversationMode",
      "createdAt",
      "customInstruction",
      "lexicalRewriteInstructions",
      "metadataFieldSuggestions",
      "metadataRules",
      "queryRewriteEnabled",
      "rerankEnabled",
      "rerankTopK",
      "semanticRewriteInstructions",
      "similarityThreshold",
      "suggestedQuestionsCount",
      "suggestedQuestionsEnabled",
      "updatedAt",
      "vectorTopK",
      "workspaceId",
    ]);
    expect(response.body.vectorTopK).toBe(15);
    expect(response.body.citationDisplayEnabled).toBe(true);
    expect(response.body.answerSupportValidationEnabled).toBe(true);
    expect(response.body.customInstruction).toBe("");
    expect(response.body.semanticRewriteInstructions).toEqual(expect.any(String));
    expect(response.body.lexicalRewriteInstructions).toEqual(expect.any(String));
    expect(response.body.conversationMode).toBe("guided");
    expect(response.body.suggestedQuestionsEnabled).toBe(true);
    expect(response.body.suggestedQuestionsCount).toBe(3);
    expect(response.body.metadataFieldSuggestions).toEqual([]);
    expect(response.body.metadataRules).toEqual([]);
  });

  it("updates retrieval settings for a valid session workspace context", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "settings-update@example.com");

    await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({
        title: "Metadata policy doc",
        content: "Metadata rich content",
        metadata: {
          language: "en",
        },
      });

    const response = await request(app)
      .put("/api/v1/settings/retrieval")
      .set(adminSessionHeaders(session))
      .send({
        queryRewriteEnabled: true,
        semanticRewriteInstructions: "Keep the query meaning-preserving and standalone.",
        lexicalRewriteInstructions: "Prefer exact literals, aliases, and corpus-native notation.",
        conversationMode: "exploratory",
        suggestedQuestionsEnabled: true,
        suggestedQuestionsCount: 4,
        rerankEnabled: true,
        vectorTopK: 12,
        similarityThreshold: 0.4,
        rerankTopK: 6,
        citationDisplayEnabled: false,
        customInstruction: "Always cite the paragraph number from the Immigration Act.",
        metadataRules: [
          {
            id: "rule-language",
            field: "language",
            valueType: "string",
            operator: "equals",
            value: "en",
            effect: "filter",
            enabled: true,
          },
        ],
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      queryRewriteEnabled: true,
      semanticRewriteInstructions: "Keep the query meaning-preserving and standalone.",
      lexicalRewriteInstructions: "Prefer exact literals, aliases, and corpus-native notation.",
      conversationMode: "exploratory",
      suggestedQuestionsEnabled: true,
      suggestedQuestionsCount: 4,
      rerankEnabled: true,
      vectorTopK: 12,
      similarityThreshold: 0.4,
      rerankTopK: 6,
      citationDisplayEnabled: false,
      customInstruction: "Always cite the paragraph number from the Immigration Act.",
      metadataRules: [
        {
          id: "rule-language",
          field: "language",
          valueType: "string",
          operator: "equals",
          value: "en",
          effect: "filter",
          enabled: true,
          triggerMode: "always_on",
        },
      ],
    });
  });

  it("updates retrieval settings with trigger-aware metadata rules", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "settings-trigger-update@example.com");

    const response = await request(app)
      .put("/api/v1/settings/retrieval")
      .set(adminSessionHeaders(session))
      .send({
        queryRewriteEnabled: false,
        semanticRewriteInstructions: "Keep the query meaning-preserving and standalone.",
        lexicalRewriteInstructions: "Prefer exact literals, aliases, and corpus-native notation.",
        conversationMode: "guided",
        suggestedQuestionsEnabled: true,
        suggestedQuestionsCount: 3,
        rerankEnabled: false,
        vectorTopK: 15,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        citationDisplayEnabled: true,
        customInstruction: "",
        metadataRules: [
          {
            id: "rule-upcoming-events",
            field: "dateFrom",
            valueType: "date",
            operator: "gte",
            value: "today()",
            effect: "filter",
            enabled: true,
            triggerMode: "match_turn",
            triggerInstruction: "Enact when the user is clearly asking about upcoming events or time-bound courses.",
          },
        ],
      });

    expect(response.status).toBe(200);
    expect(response.body.metadataRules).toEqual([
      {
        id: "rule-upcoming-events",
        field: "dateFrom",
        valueType: "date",
        operator: "gte",
        value: "today()",
        combinator: "and",
        conditions: [
          expect.objectContaining({
            field: "dateFrom",
            valueType: "date",
            operator: "gte",
            value: "today()",
          }),
        ],
        effect: "filter",
        enabled: true,
        triggerMode: "match_turn",
        triggerInstruction: "Enact when the user is clearly asking about upcoming events or time-bound courses.",
      },
    ]);
  });

  it("preserves saved signal policies when an older client omits the field", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "settings-preserve@example.com");

    await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({
        title: "Metadata policy doc",
        content: "Metadata rich content",
        metadata: {
          language: "en",
        },
      });

    const firstUpdate = await request(app)
      .put("/api/v1/settings/retrieval")
      .set(adminSessionHeaders(session))
      .send({
        queryRewriteEnabled: true,
        semanticRewriteInstructions: "Keep the meaning.",
        lexicalRewriteInstructions: "Prefer exact notation.",
        conversationMode: "factual",
        suggestedQuestionsEnabled: false,
        suggestedQuestionsCount: 1,
        rerankEnabled: true,
        vectorTopK: 12,
        similarityThreshold: 0.4,
        rerankTopK: 6,
        citationDisplayEnabled: false,
        customInstruction: "Cite paragraph numbers.",
        metadataRules: [
          {
            id: "rule-language",
            field: "language",
            valueType: "string",
            operator: "equals",
            value: "en",
            effect: "filter",
            enabled: true,
          },
        ],
      });

    const secondUpdate = await request(app)
      .put("/api/v1/settings/retrieval")
      .set(adminSessionHeaders(session))
      .send({
        queryRewriteEnabled: false,
        rerankEnabled: false,
        vectorTopK: 20,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        citationDisplayEnabled: true,
      });

    expect(firstUpdate.status).toBe(200);
    expect(secondUpdate.status).toBe(200);
    expect(secondUpdate.body.metadataRules).toEqual(firstUpdate.body.metadataRules);
    expect(secondUpdate.body.customInstruction).toBe("Cite paragraph numbers.");
    expect(secondUpdate.body.semanticRewriteInstructions).toBe("Keep the meaning.");
    expect(secondUpdate.body.lexicalRewriteInstructions).toBe("Prefer exact notation.");
    expect(secondUpdate.body.conversationMode).toBe("factual");
    expect(secondUpdate.body.suggestedQuestionsEnabled).toBe(false);
    expect(secondUpdate.body.suggestedQuestionsCount).toBe(1);
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

  it("documents the retrieval and ingestion settings split in the generated schema", () => {
    const spec = readFileSync(new URL("../../openapi.yaml", import.meta.url), "utf8");
    const retrievalSettingsSchema = spec.match(/RetrievalSettings:\n([\s\S]*?)\n    UpdateRetrievalSettingsRequest:/)?.[1] ?? "";
    const retrievalUpdateSchema = spec.match(/UpdateRetrievalSettingsRequest:\n([\s\S]*?)\n    IngestionSettings:/)?.[1] ?? "";
    const ingestionSettingsSchema = spec.match(/IngestionSettings:\n([\s\S]*?)\n    UpdateIngestionSettingsRequest:/)?.[1] ?? "";
    const ingestionUpdateSchema = spec.match(/UpdateIngestionSettingsRequest:\n([\s\S]*?)\n    RetrievalMetadataRule:/)?.[1] ?? "";

    expect(retrievalSettingsSchema).not.toContain("chunkingStrategy:");
    expect(retrievalSettingsSchema).toContain("semanticRewriteInstructions:");
    expect(retrievalSettingsSchema).toContain("lexicalRewriteInstructions:");
    expect(retrievalSettingsSchema).toContain("conversationMode:");
    expect(retrievalSettingsSchema).toContain("suggestedQuestionsEnabled:");
    expect(retrievalSettingsSchema).toContain("suggestedQuestionsCount:");
    expect(retrievalUpdateSchema).toContain("metadataRules:");
    expect(retrievalUpdateSchema).toContain("semanticRewriteInstructions:");
    expect(retrievalUpdateSchema).toContain("suggestedQuestionsEnabled:");
    expect(retrievalUpdateSchema).toContain("suggestedQuestionsCount:");
    expect(retrievalUpdateSchema).toContain("lexicalRewriteInstructions:");
    expect(retrievalUpdateSchema).toContain("conversationMode:");
    expect(retrievalUpdateSchema).not.toContain("chunkingStrategy:");
    expect(ingestionSettingsSchema).toContain("chunkingStrategy:");
    expect(ingestionSettingsSchema).toContain("fixedWindowChunkSize:");
    expect(ingestionUpdateSchema).toContain("fixedWindowChunkOverlap:");
    expect(ingestionUpdateSchema).toContain("structuredMinChunkSize:");
    expect(spec).toContain("/api/v1/settings:");
    expect(spec).toContain("PlatformSettingsResponse:");
    expect(spec).toContain("UpdatePlatformSettingsRequest:");
    expect(spec).toContain("/api/v1/settings/ingestion:");
    expect(spec).toContain("/api/v1/settings/ingestion/reprocess:");
  });
});
