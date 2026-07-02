import { randomUUID } from "node:crypto";

import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { IngestionSettingsRepository } from "../../src/db/repositories/ingestionSettingsRepository.js";
import { defaultIngestionSettings } from "../../src/modules/settings/contracts/ingestion.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";
import { createTestApp, issueTestToken } from "../support/testApp.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

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

  it("persists ingestion document enrichment defaults through the settings API", async () => {
    const { app } = createTestApp();

    const { token } = await issueTestToken(app, "document-enrichment-settings@example.com");
    const authorization = `Bearer ${token}`;

    const initial = await request(app)
      .get("/api/v1/settings/ingestion")
      .set("Authorization", authorization);

    expect(initial.status).toBe(200);
    expect(initial.body.documentEnrichmentEnabled).toBe(false);

    const updated = await request(app)
      .put("/api/v1/settings/ingestion")
      .set("Authorization", authorization)
      .send({
        chunkingStrategy: "fixed_window",
        fixedWindowChunkSize: 800,
        fixedWindowChunkOverlap: 120,
        structuredMinChunkSize: 24,
        structuredMaxChunkSize: 220,
        documentEnrichmentEnabled: true,
      });

    expect(updated.status).toBe(200);
    expect(updated.body.documentEnrichmentEnabled).toBe(true);

    const reloaded = await request(app)
      .get("/api/v1/settings/ingestion")
      .set("Authorization", authorization);

    expect(reloaded.body.documentEnrichmentEnabled).toBe(true);
  });

  it("allows different workspaces to reuse the same externalDocumentId", async () => {
    const { app } = createTestApp();

    const { token: firstToken } = await issueTestToken(app, "external-doc-one@example.com");
    const { token: secondToken } = await issueTestToken(app, "external-doc-two@example.com");

    const firstResponse = await request(app)
      .post("/api/v1/document/")
      .set("Authorization", `Bearer ${firstToken}`)
      .send({
        title: "Workspace one doc",
        content: "Workspace one content",
        externalDocumentId: "crm-123",
      });

    const secondResponse = await request(app)
      .post("/api/v1/document/")
      .set("Authorization", `Bearer ${secondToken}`)
      .send({
        title: "Workspace two doc",
        content: "Workspace two content",
        externalDocumentId: "crm-123",
      });

    expect(firstResponse.status).toBe(202);
    expect(secondResponse.status).toBe(202);
    expect(secondResponse.body.documentId).not.toBe(firstResponse.body.documentId);
  });

  it("keeps metadata field suggestions workspace scoped", async () => {
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
      metadata: { language: "en", region: "us" },
      sourceKind: "inline_text",
      status: "ready",
    });

    await repositories.documentRepository.create({
      workspaceId: secondWorkspaceId,
      title: "Second metadata doc",
      sourceContent: "Language doc",
      markdownContent: "Language doc",
      metadata: { language: "et", locale: "ee" },
      sourceKind: "inline_text",
      status: "ready",
    });

    const firstFields = await request(app)
      .get("/api/v1/settings/retrieval-defaults")
      .set("Authorization", firstAuthorization);

    const secondFields = await request(app)
      .get("/api/v1/settings/retrieval-defaults")
      .set("Authorization", secondAuthorization);

    expect(firstFields.status).toBe(200);
    expect(secondFields.status).toBe(200);

    const firstFieldNames = firstFields.body.metadataFieldSuggestions.map(
      (suggestion: { field: string }) => suggestion.field,
    );
    const secondFieldNames = secondFields.body.metadataFieldSuggestions.map(
      (suggestion: { field: string }) => suggestion.field,
    );

    // Each workspace sees only its own documents' metadata fields.
    expect(firstFieldNames).toContain("region");
    expect(firstFieldNames).not.toContain("locale");
    expect(secondFieldNames).toContain("locale");
    expect(secondFieldNames).not.toContain("region");
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

  it("discovers metadata-backed field suggestions from workspace documents", async () => {
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

    const fields = await request(app)
      .get("/api/v1/settings/retrieval-defaults")
      .set("Authorization", authorization);

    expect(fields.status).toBe(200);
    expect(fields.body.metadataFieldSuggestions).toEqual(
      expect.arrayContaining([
        { field: "language", inferredType: "string" },
        { field: "parsedData.url", inferredType: "string" },
      ]),
    );
  });
});

describeIntegration("IngestionSettingsRepository document enrichment settings (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl as string);
  const repository = new IngestionSettingsRepository(database.kysely);

  const accountId = randomUUID();
  const workspaceId = randomUUID();

  beforeAll(async () => {
    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [accountId, "Ingestion Settings Test Co", `settings-${accountId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [workspaceId, accountId, "Ingestion Settings Workspace", `settings-route-${workspaceId}`],
    );
  });

  afterAll(async () => {
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("defaults document enrichment to false and persists updates", async () => {
    const defaults = defaultIngestionSettings(workspaceId);

    const inserted = await repository.upsert(workspaceId, defaults);
    expect(inserted.documentEnrichmentEnabled).toBe(false);
    expect((await repository.findByWorkspaceId(workspaceId))?.documentEnrichmentEnabled).toBe(false);

    const enabled = await repository.upsert(workspaceId, {
      ...defaults,
      fixedWindowChunkSize: 900,
      documentEnrichmentEnabled: true,
    });

    expect(enabled.documentEnrichmentEnabled).toBe(true);
    expect(enabled.fixedWindowChunkSize).toBe(900);
    expect((await repository.findByWorkspaceId(workspaceId))?.documentEnrichmentEnabled).toBe(true);
  });
});
