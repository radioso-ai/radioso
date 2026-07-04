import { randomUUID } from "node:crypto";

import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DocumentProcessingService } from "../../src/modules/documents/services/documentProcessingService.js";
import type { DocumentEnrichmentStagePort } from "../../src/modules/documents/services/documentEnrichmentService.js";
import { ChunkingStrategyRegistry } from "../../src/modules/retrieval/domain/chunking/chunkingStrategyRegistry.js";
import type { ChunkingStrategy } from "../../src/modules/retrieval/domain/chunking/chunkingStrategy.js";
import { EmbeddingService } from "../../src/modules/retrieval/services/embeddingService.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";
import { createAuditService } from "../support/fakes.js";
import {
  InMemoryChunkRepository,
  InMemoryDocumentProcessingJobRepository,
  InMemoryDocumentRepository,
} from "../support/fakes.js";
import { createTestApp, issueTestToken } from "../support/testApp.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const fixedWindowStrategy: ChunkingStrategy = {
  id: "fixed_window",
  async chunk(input) {
    const size = input.config.fixedWindowChunkSize;
    const chunks = [];
    for (let start = 0; start < input.content.length; start += size) {
      const end = Math.min(input.content.length, start + size);
      chunks.push({
        chunkIndex: chunks.length,
        content: input.content.slice(start, end),
        startOffset: start,
        endOffset: end,
      });
      if (end === input.content.length) {
        break;
      }
    }
    return chunks;
  },
};

describe("document chunking integration", () => {
  it("applies the structured strategy to newly ingested documents", async () => {
    const { app, repositories } = createTestApp();

    const { token } = await issueTestToken(app, "structured-ingest@example.com");
    const authorization = `Bearer ${token}`;

    await request(app)
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
        title: "Playbook",
        content: `# Intro

Welcome to Hivec.

- Open Settings
- Choose a strategy

## FAQ

What changes now?

Only future ingests change.`,
      });

    expect(document.status).toBe(202);
    const storedChunks = repositories.chunkRepository.items.get(document.body.documentId) ?? [];
    expect(storedChunks.length).toBeGreaterThan(1);
    expect(storedChunks.some((chunk) => chunk.content.includes("Open Settings"))).toBe(true);
    expect(storedChunks.some((chunk) => chunk.content.includes("What changes now?"))).toBe(true);
  });

  it("propagates document metadata to every chunk produced during processing", async () => {
    const { app, repositories } = createTestApp();

    const { token } = await issueTestToken(app, "metadata-propagation@example.com");
    const authorization = `Bearer ${token}`;

    const document = await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({
        title: "Source Guide",
        content: "This guide explains how to use the API for external integrations.",
        metadata: { sourceUrl: "https://example.com", language: "en" },
      });

    expect(document.status).toBe(202);
    const storedChunks = repositories.chunkRepository.items.get(document.body.documentId) ?? [];
    expect(storedChunks.length).toBeGreaterThan(0);
    for (const chunk of storedChunks) {
      expect(chunk.metadata).toMatchObject({ sourceUrl: "https://example.com", language: "en" });
    }
  });

  it("does not rewrite existing chunks until the document is updated", async () => {
    const { app, repositories } = createTestApp();

    const { token } = await issueTestToken(app, "strategy-update@example.com");
    const authorization = `Bearer ${token}`;

    const created = await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({
        title: "Original",
        content: "word ".repeat(400),
      });

    const originalChunks = [...(repositories.chunkRepository.items.get(created.body.documentId) ?? [])];

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

    expect(settings.status).toBe(200);
    expect(repositories.chunkRepository.items.get(created.body.documentId)).toEqual(originalChunks);

    const updated = await request(app)
      .put(`/api/v1/document/${created.body.documentId}`)
      .set("Authorization", authorization)
      .send({
        title: "Updated",
        content: `# Updated

Alpha details.

## Follow-up

What changed?

Chunking behavior.`,
      });

    expect(updated.status).toBe(202);
    const updatedChunks = repositories.chunkRepository.items.get(created.body.documentId) ?? [];
    expect(updatedChunks).not.toEqual(originalChunks);
    expect(updatedChunks.some((chunk) => chunk.content.includes("What changed?"))).toBe(true);
  });

  it("stores enriched event dates on overlapping chunks and renders per-chunk search text", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const chunkRepository = new InMemoryChunkRepository(documentRepository);
    const auditService = createAuditService();
    const content = [
      "Summer Workshop introduces advanced meditation practice for returning students.",
      "Registration details are published below.",
      "The workshop takes place on August 10, 2026.",
    ].join("\n\n");
    const document = await documentRepository.create({
      workspaceId: "workspace-enriched",
      title: "Summer Workshop",
      sourceContent: content,
      markdownContent: content,
      status: "queued",
    });
    const enrichmentStage: DocumentEnrichmentStagePort = {
      async enrich({ chunks }) {
        return {
          status: "applied",
          documentMetadata: {},
          provenance: {
            status: "applied" as const,
            shape: "event" as const,
            model: "gpt-5.2",
            enrichedAt: "2026-07-02T12:00:00.000Z",
            anchorDate: "2026-07-02",
            anchorSource: "document_created_at" as const,
            factCount: 1,
            appliedChunkCount: 1,
            failureReason: null,
          },
          chunks: chunks.map((chunk) => {
            const eventOffset = content.indexOf("Summer Workshop");
            return chunk.startOffset <= eventOffset && eventOffset < chunk.endOffset
              ? { ...chunk, metadata: { ...chunk.metadata, dateFrom: "2026-08-10", dateTo: "2026-08-10" } }
              : chunk;
          }),
          factCount: 1,
          appliedChunkCount: 1,
        };
      },
    };
    const service = new DocumentProcessingService(
      documentRepository,
      chunkRepository,
      new EmbeddingService({
        async embedTexts(texts: string[]): Promise<number[][]> {
          return texts.map(() => [1, 2, 3]);
        },
      }),
      auditService,
      {
        async getForWorkspace(workspaceId: string) {
          return {
            workspaceId,
            chunkingStrategy: "fixed_window",
            fixedWindowChunkSize: 110,
            fixedWindowChunkOverlap: 0,
            structuredMinChunkSize: 24,
            structuredMaxChunkSize: 220,
            embeddingModel: "text-embedding-3-small",
            pendingEmbeddingModel: null,
            documentEnrichmentEnabled: true,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        },
      },
      new ChunkingStrategyRegistry([fixedWindowStrategy]),
      undefined,
      undefined,
      enrichmentStage,
    );

    const outcome = await service.process({
      id: "job-enriched",
      documentId: document.id,
      workspaceId: document.workspaceId,
      documentRevision: document.revision,
      status: "queued",
      attemptCount: 0,
      lastError: null,
      availableAt: new Date(),
      claimedAt: null,
      completedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      options: null,
    });

    expect(outcome).toBe("completed");
    const stored = chunkRepository.items.get(document.id) ?? [];
    const eventChunk = stored.find((chunk) => chunk.content.includes("Summer Workshop"));
    const dateOnlyChunk = stored.find((chunk) => chunk.content.includes("August 10"));

    expect(eventChunk?.metadata).toMatchObject({ dateFrom: "2026-08-10", dateTo: "2026-08-10" });
    expect(eventChunk?.searchText).toContain("Date from: 2026-08-10");
    expect(dateOnlyChunk?.metadata).not.toHaveProperty("dateFrom");
    expect((await documentRepository.findByIdAndWorkspaceId(document.id, document.workspaceId))?.enrichment).toMatchObject({
      status: "applied",
      shape: "event",
      factCount: 1,
      appliedChunkCount: 1,
    });
  });

  it("clears stale temporal enrichment when reprocessing with enrichment disabled", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const chunkRepository = new InMemoryChunkRepository(documentRepository);
    const auditService = createAuditService();
    const document = await documentRepository.create({
      workspaceId: "workspace-clear-enrichment",
      title: "Past enrichment",
      sourceContent: "Event content",
      markdownContent: "Event content",
      status: "queued",
      metadata: {
        sourceUrl: "https://events.example/event",
        dateFrom: "2026-08-10",
        dateTo: "2026-08-10",
      },
    });
    // Prior extraction is recorded in the dedicated provenance column.
    await documentRepository.updateMetadataForRevision({
      documentId: document.id,
      workspaceId: "workspace-clear-enrichment",
      revision: document.revision,
      metadata: {
        sourceUrl: "https://events.example/event",
        dateFrom: "2026-08-10",
        dateTo: "2026-08-10",
      },
      enrichment: { status: "applied" },
    });
    const service = new DocumentProcessingService(
      documentRepository,
      chunkRepository,
      new EmbeddingService({
        async embedTexts(texts: string[]): Promise<number[][]> {
          return texts.map(() => [1, 2, 3]);
        },
      }),
      auditService,
      {
        async getForWorkspace(workspaceId: string) {
          return {
            workspaceId,
            chunkingStrategy: "fixed_window",
            fixedWindowChunkSize: 1000,
            fixedWindowChunkOverlap: 0,
            structuredMinChunkSize: 24,
            structuredMaxChunkSize: 220,
            embeddingModel: "text-embedding-3-small",
            pendingEmbeddingModel: null,
            documentEnrichmentEnabled: false,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        },
      },
      new ChunkingStrategyRegistry([fixedWindowStrategy]),
    );

    await service.process({
      id: "job-clear-enrichment",
      documentId: document.id,
      workspaceId: document.workspaceId,
      documentRevision: document.revision,
      status: "queued",
      attemptCount: 0,
      lastError: null,
      availableAt: new Date(),
      claimedAt: null,
      completedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      options: { documentEnrichmentOverride: "off" },
    });

    const current = await documentRepository.findByIdAndWorkspaceId(document.id, document.workspaceId);
    expect(current?.metadata).toEqual({ sourceUrl: "https://events.example/event" });
    expect(chunkRepository.items.get(document.id)?.[0]?.metadata).toEqual({ sourceUrl: "https://events.example/event" });
  });
});

describeIntegration("chunk temporal generated columns (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl as string);
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const documentId = randomUUID();

  beforeAll(async () => {
    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [accountId, "Chunk Temporal Test Co", `chunk-${accountId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [workspaceId, accountId, "Chunk Temporal Workspace", `chunk-route-${workspaceId}`],
    );
    await database.query(
      `INSERT INTO documents (id, workspace_id, title, source_content, markdown_content, status, metadata)
       VALUES ($1, $2, $3, $4, $4, 'ready', '{}'::jsonb)`,
      [documentId, workspaceId, "Generated Date Document", "Generated date content"],
    );
  });

  afterAll(async () => {
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("derives chunk date_from and date_to from metadata and falls back date_to to dateFrom", async () => {
    const rangedChunkId = randomUUID();
    const singleDayChunkId = randomUUID();
    const invalidChunkId = randomUUID();

    await database.query(
      `INSERT INTO chunks (id, document_id, workspace_id, chunk_index, content, search_text, metadata)
       VALUES ($1, $4, $5, 0, 'ranged', 'ranged', $6::jsonb),
              ($2, $4, $5, 1, 'single day', 'single day', $7::jsonb),
              ($3, $4, $5, 2, 'invalid', 'invalid', $8::jsonb)`,
      [
        rangedChunkId,
        singleDayChunkId,
        invalidChunkId,
        documentId,
        workspaceId,
        JSON.stringify({ dateFrom: "2026-08-10", dateTo: "2026-08-12" }),
        JSON.stringify({ dateFrom: "2026-09-01" }),
        JSON.stringify({ dateFrom: "August 10, 2026", dateTo: "not-a-date" }),
      ],
    );

    const rows = await database.query<{ id: string; date_from: string | null; date_to: string | null }>(
      `SELECT id, date_from::text, date_to::text
       FROM chunks
       WHERE id = ANY($1::uuid[])
       ORDER BY chunk_index ASC`,
      [[rangedChunkId, singleDayChunkId, invalidChunkId]],
    );

    expect(rows).toEqual([
      { id: rangedChunkId, date_from: "2026-08-10", date_to: "2026-08-12" },
      { id: singleDayChunkId, date_from: "2026-09-01", date_to: "2026-09-01" },
      { id: invalidChunkId, date_from: null, date_to: null },
    ]);
  });

  it("resolves ISO-shaped but calendar-invalid dates to NULL instead of failing the insert", async () => {
    // to_date raises on 2026-02-31; the generated columns must swallow that so
    // caller-supplied metadata can never fail chunk persistence.
    const impossibleDateChunkId = randomUUID();

    await database.query(
      `INSERT INTO chunks (id, document_id, workspace_id, chunk_index, content, search_text, metadata)
       VALUES ($1, $2, $3, 3, 'impossible date', 'impossible date', $4::jsonb)`,
      [
        impossibleDateChunkId,
        documentId,
        workspaceId,
        JSON.stringify({ dateFrom: "2026-02-31", dateTo: "2026-11-31" }),
      ],
    );

    const rows = await database.query<{ date_from: string | null; date_to: string | null }>(
      `SELECT date_from::text, date_to::text FROM chunks WHERE id = $1`,
      [impossibleDateChunkId],
    );

    expect(rows).toEqual([{ date_from: null, date_to: null }]);
  });
});
