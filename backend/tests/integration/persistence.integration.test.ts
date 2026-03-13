import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";

import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { ChunkRepository } from "../../src/db/repositories/chunkRepository.js";
import { DocumentRepository } from "../../src/db/repositories/documentRepository.js";
import { AuditService } from "../../src/modules/audit/services/auditService.js";
import { DocumentIngestionService } from "../../src/modules/documents/services/documentIngestionService.js";
import { PgVectorSearch } from "../../src/modules/retrieval/infra/vectorSearch.js";
import { EmbeddingService, type EmbeddingGateway } from "../../src/modules/retrieval/services/embeddingService.js";
import { Database } from "../../src/shared/infra/database.js";
import { createLogger } from "../../src/shared/observability/logger.js";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const noopAuditRepository = {
  async create() {
    return {
      id: randomUUID(),
      accountId: null,
      eventType: "",
      eventStatus: "",
      metadata: {},
      createdAt: new Date(),
    };
  },
};
const describeIfDatabase = integrationDatabaseUrl ? describe : describe.skip;

describeIfDatabase("persistence integration", () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const migrationPath = path.resolve(__dirname, "../../src/db/migrations/001_init.sql");

  let database: Database;

  beforeAll(async () => {
    database = new Database(integrationDatabaseUrl!);
    const migrationSql = await readFile(migrationPath, "utf8");
    await database.pool.query(migrationSql);
  });

  afterAll(async () => {
    await database.close();
  });

  const embeddingOf = (axis: 0 | 1): number[] => {
    const embedding = new Array<number>(1536).fill(0);
    embedding[axis] = 1;
    return embedding;
  };

  it("persists records and returns account-scoped vector matches", async () => {
    const accountRepository = new AccountRepository(database);
    const documentRepository = new DocumentRepository(database);
    const chunkRepository = new ChunkRepository(database);
    const vectorSearch = new PgVectorSearch(database);

    const accountA = await accountRepository.create({
      email: `persist-a-${randomUUID()}@example.com`,
      passwordHash: "hash-a",
    });
    const accountB = await accountRepository.create({
      email: `persist-b-${randomUUID()}@example.com`,
      passwordHash: "hash-b",
    });

    const documentA = await documentRepository.create({
      accountId: accountA.id,
      title: "Guide A",
      sourceContent: "The test page explains ingestion.",
      markdownContent: "The test page explains ingestion.",
      status: "ready",
    });
    const documentB = await documentRepository.create({
      accountId: accountB.id,
      title: "Guide B",
      sourceContent: "Other account content.",
      markdownContent: "Other account content.",
      status: "ready",
    });

    await chunkRepository.replaceForDocument(documentA.id, [
      {
        id: randomUUID(),
        documentId: documentA.id,
        accountId: accountA.id,
        chunkIndex: 0,
        content: "The test page explains ingestion and parsing.",
        embedding: embeddingOf(0),
        startOffset: 0,
        endOffset: 43,
        createdAt: new Date(),
      },
    ]);
    await chunkRepository.replaceForDocument(documentB.id, [
      {
        id: randomUUID(),
        documentId: documentB.id,
        accountId: accountB.id,
        chunkIndex: 0,
        content: "This belongs to another account.",
        embedding: embeddingOf(1),
        startOffset: 0,
        endOffset: 31,
        createdAt: new Date(),
      },
    ]);

    const matches = await vectorSearch.search({
      accountId: accountA.id,
      queryEmbedding: embeddingOf(0),
      topK: 5,
      similarityThreshold: 0.1,
    });

    expect(matches).toHaveLength(1);
    expect(matches[0].documentId).toBe(documentA.id);

    await database.query("DELETE FROM chunks WHERE account_id = $1 OR account_id = $2", [accountA.id, accountB.id]);
    await database.query("DELETE FROM documents WHERE account_id = $1 OR account_id = $2", [accountA.id, accountB.id]);
    await database.query("DELETE FROM accounts WHERE id = $1 OR id = $2", [accountA.id, accountB.id]);
  });

  it("stores raw chunk content while generating title-aware retrieval embeddings", async () => {
    const accountRepository = new AccountRepository(database);
    const documentRepository = new DocumentRepository(database);
    const chunkRepository = new ChunkRepository(database);
    const vectorSearch = new PgVectorSearch(database);

    const capturedTexts: string[] = [];
    const embeddingGateway: EmbeddingGateway = {
      async embedTexts(texts: string[]): Promise<number[][]> {
        capturedTexts.push(...texts);
        return texts.map((text) =>
          text.includes("Title: Session Cookie") ? embeddingOf(0) : embeddingOf(1),
        );
      },
    };

    const ingestionService = new DocumentIngestionService(
      documentRepository,
      chunkRepository,
      new EmbeddingService(embeddingGateway),
      new AuditService(createLogger("silent"), noopAuditRepository),
    );

    const account = await accountRepository.create({
      email: `title-aware-${randomUUID()}@example.com`,
      passwordHash: "hash-a",
    });

    const sessionCookie = await ingestionService.ingest({
      accountId: account.id,
      title: "Session Cookie",
      content: "Used for account registration and bearer token issuance.",
    });
    const auditEvents = await ingestionService.ingest({
      accountId: account.id,
      title: "Audit Events",
      content: "Used for recording security-relevant activity.",
    });

    expect(capturedTexts.some((text) => text.startsWith("Title: Session Cookie"))).toBe(true);

    const storedChunks = await database.query<{ content: string }>(
      "SELECT content FROM chunks WHERE document_id = $1 ORDER BY chunk_index ASC",
      [sessionCookie.documentId],
    );
    expect(storedChunks[0]?.content).toContain("Used for account registration");
    expect(storedChunks[0]?.content).not.toContain("Title:");

    const matches = await vectorSearch.search({
      accountId: account.id,
      queryEmbedding: embeddingOf(0),
      topK: 5,
      similarityThreshold: 0.1,
    });

    expect(matches[0]?.title).toBe("Session Cookie");
    expect(matches[0]?.content).toContain("Used for account registration");

    await database.query("DELETE FROM chunks WHERE account_id = $1", [account.id]);
    await database.query("DELETE FROM documents WHERE account_id = $1", [account.id]);
    await database.query("DELETE FROM accounts WHERE id = $1", [account.id]);
    expect(auditEvents.status).toBe("ready");
  });

  it("records retrieval execution metadata without exposing new response fields", async () => {
    const logger = {
      info: vi.fn(),
    };
    const auditService = new AuditService(logger as unknown as ReturnType<typeof createLogger>, noopAuditRepository);

    await auditService.record({
      accountId: randomUUID(),
      eventType: "chat.answer",
      eventStatus: "success",
      metadata: {
        conversationId: randomUUID(),
        citationCount: 2,
        retrieval: {
          rewriteStatus: "applied",
          rerankStatus: "fallback",
          originalCandidateCount: 12,
          rewrittenCandidateCount: 9,
          normalizedCandidateCount: 14,
          finalContextCount: 4,
          candidateFallbackApplied: false,
          fallbackApplied: true,
        },
      },
    });

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        retrieval: {
          rewriteStatus: "applied",
          rerankStatus: "fallback",
          originalCandidateCount: 12,
          rewrittenCandidateCount: 9,
          normalizedCandidateCount: 14,
          finalContextCount: 4,
          candidateFallbackApplied: false,
          fallbackApplied: true,
        },
      }),
      "audit_event",
    );
  });
});
