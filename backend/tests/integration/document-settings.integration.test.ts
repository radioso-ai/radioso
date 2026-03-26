import request from "supertest";
import { describe, expect, it } from "vitest";

import { createTestApp, issueTestToken } from "../support/testApp.js";

describe("document and settings integration", () => {
  it("rejects invalid settings payloads", async () => {
    const { app } = createTestApp();

    const { token } = await issueTestToken(app, "invalid-settings@example.com");

    const response = await request(app)
      .put("/api/v1/settings/ingestion")
      .set("Authorization", `Bearer ${token}`)
      .send({
        chunkingStrategy: "fixed_window",
        fixedWindowChunkSize: 200,
        fixedWindowChunkOverlap: 200,
        structuredMinChunkSize: 24,
        structuredMaxChunkSize: 220,
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

    const { token } = await issueTestToken(app, "workflow@example.com");
    const authorization = `Bearer ${token}`;

    const settings = await request(app)
      .put("/api/v1/settings/ingestion")
      .set("Authorization", authorization)
      .send({
        chunkingStrategy: "structured_semantic",
        fixedWindowChunkSize: 800,
        fixedWindowChunkOverlap: 120,
        structuredMinChunkSize: 24,
        structuredMaxChunkSize: 220,
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

  it("keeps metadata signal policies account scoped", async () => {
    const { app, repositories } = createTestApp();

    const { token: firstToken, workspaceId: firstWorkspaceId } = await issueTestToken(app, "controls-one@example.com");
    const { token: secondToken, workspaceId: secondWorkspaceId } = await issueTestToken(app, "controls-two@example.com");

    const firstAuthorization = `Bearer ${firstToken}`;
    const secondAuthorization = `Bearer ${secondToken}`;

    await repositories.documentRepository.create({
      workspaceId: firstWorkspaceId,
      title: "First metadata doc",
      sourceContent: "Language doc",
      markdownContent: "Language doc",
      metadata: { language: "en" },
      sourceKind: "inline_text",
      status: "ready",
    });

    await repositories.documentRepository.create({
      workspaceId: secondWorkspaceId,
      title: "Second metadata doc",
      sourceContent: "Language doc",
      markdownContent: "Language doc",
      metadata: { language: "et" },
      sourceKind: "inline_text",
      status: "ready",
    });

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
        customInstruction: "",
        signalPolicies: [{ signalKey: "metadata.language", enabled: true, mode: "hard_filter" }],
      });

    const secondSettings = await request(app)
      .get("/api/v1/settings/retrieval")
      .set("Authorization", secondAuthorization);

    expect(firstUpdate.status).toBe(200);
    expect(firstUpdate.body.signalPolicies).toContainEqual({
      signalKey: "metadata.language",
      enabled: true,
      mode: "hard_filter",
    });
    expect(secondSettings.status).toBe(200);
    expect(secondSettings.body.signalPolicies).toEqual([
      { signalKey: "metadata.language", enabled: false, mode: "boost_only" },
    ]);
  });

  it("queues eligible workspace documents for reprocessing from ingestion settings", async () => {
    const { app, repositories } = createTestApp();

    const { token } = await issueTestToken(app, "workspace-reprocess@example.com");
    const authorization = `Bearer ${token}`;

    const first = await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({
        title: "Doc one",
        content: "Alpha content ".repeat(80),
      });

    const second = await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({
        title: "Doc two",
        content: "Beta content ".repeat(80),
      });

    const firstDocument = repositories.documentRepository.items.get(first.body.documentId)!;
    repositories.documentRepository.items.set(first.body.documentId, {
      ...firstDocument,
      status: "processing",
    });

    const response = await request(app)
      .post("/api/v1/settings/ingestion/reprocess")
      .set("Authorization", authorization);

    expect(response.status).toBe(202);
    expect(response.body.queuedDocumentCount).toBe(1);
    expect(response.body.skippedDocumentCount).toBe(1);
    expect(repositories.documentRepository.items.get(second.body.documentId)?.status).toBe("ready");
  });

  it("discovers metadata-backed signal definitions and persists metadata policies", async () => {
    const { app, repositories } = createTestApp();

    const { token, workspaceId } = await issueTestToken(app, "metadata-signals@example.com");
    const authorization = `Bearer ${token}`;

    await repositories.documentRepository.create({
      workspaceId,
      title: "Metadata rich document",
      sourceContent: "Metadata source content",
      markdownContent: "Metadata source content",
      metadata: {
        language: "en",
        parsedData: {
          url: "https://example.com/a",
        },
      },
      sourceKind: "inline_text",
      status: "ready",
    });

    const settings = await request(app)
      .get("/api/v1/settings/retrieval")
      .set("Authorization", authorization);

    expect(settings.status).toBe(200);
    expect(settings.body.signalDefinitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "metadata.language",
          source: "metadata",
        }),
        expect.objectContaining({
          key: "metadata.parsedData.url",
          source: "metadata",
        }),
      ]),
    );
    expect(settings.body.signalPolicies).toEqual(
      expect.arrayContaining([
        { signalKey: "metadata.language", enabled: false, mode: "boost_only" },
        { signalKey: "metadata.parsedData.url", enabled: false, mode: "boost_only" },
      ]),
    );

    const update = await request(app)
      .put("/api/v1/settings/retrieval")
      .set("Authorization", authorization)
      .send({
        queryRewriteEnabled: false,
        rerankEnabled: false,
        vectorTopK: 15,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        warmthLevel: 5,
        citationDisplayEnabled: true,
        customInstruction: "",
        signalPolicies: settings.body.signalPolicies.map((policy: { signalKey: string; enabled: boolean; mode: string }) =>
          policy.signalKey === "metadata.language"
            ? { ...policy, enabled: true, mode: "hard_filter" }
            : policy,
        ),
      });

    expect(update.status).toBe(200);
    expect(update.body.signalPolicies).toContainEqual({
      signalKey: "metadata.language",
      enabled: true,
      mode: "hard_filter",
    });
  });
});
