import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";

import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { ChunkRepository } from "../../src/db/repositories/chunkRepository.js";
import { DocumentRepository } from "../../src/db/repositories/documentRepository.js";
import { DocumentProcessingJobRepository } from "../../src/db/repositories/documentProcessingJobRepository.js";
import { WorkspaceRepository } from "../../src/db/repositories/workspaceRepository.js";
import { AuditService } from "../../src/modules/audit/services/auditService.js";
import { DocumentIngestionService } from "../../src/modules/documents/services/documentIngestionService.js";
import { DocumentProcessingService } from "../../src/modules/documents/services/documentProcessingService.js";
import { DocumentProcessingWorker } from "../../src/modules/documents/services/documentProcessingWorker.js";
import { ChunkingStrategyRegistry } from "../../src/modules/retrieval/domain/chunking/chunkingStrategyRegistry.js";
import { FixedWindowChunkingStrategy } from "../../src/modules/retrieval/domain/chunking/fixedWindowChunkingStrategy.js";
import { PgVectorSearch } from "../../src/modules/retrieval/infra/vectorSearch.js";
import { EmbeddingService, type EmbeddingGateway } from "../../src/modules/retrieval/services/embeddingService.js";
import { RetrievalSettingsService } from "../../src/modules/settings/services/retrievalSettingsService.js";
import { RetrievalSettingsRepository } from "../../src/db/repositories/retrievalSettingsRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { createLogger } from "../../src/shared/observability/logger.js";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const noopAuditRepository = {
  async create() {
    return {
      id: randomUUID(),
      accountId: null,
      workspaceId: null,
      eventType: "",
      eventStatus: "",
      metadata: {},
      createdAt: new Date(),
    };
  },
  async listChatAnswerEventsByConversationId() {
    return [];
  },
};
const describeIfDatabase = integrationDatabaseUrl ? describe : describe.skip;

describeIfDatabase("persistence integration", () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const migrationsPath = path.resolve(__dirname, "../../src/db/migrations");

  const runAllMigrations = async (database: Database) => {
    const migrationFiles = (await readdir(migrationsPath))
      .filter((file) => file.endsWith(".sql"))
      .sort();

    for (const migrationFile of migrationFiles) {
      const migrationSql = await readFile(path.join(migrationsPath, migrationFile), "utf8");
      await database.pool.query(migrationSql);
    }
  };

  let database: Database;
  let workspaceRepository: WorkspaceRepository;

  beforeAll(async () => {
    database = new Database(integrationDatabaseUrl!);
    workspaceRepository = new WorkspaceRepository(database);
    await runAllMigrations(database);
  });

  afterAll(async () => {
    await database.close();
  });

  const embeddingOf = (axis: 0 | 1): number[] => {
    const embedding = new Array<number>(1536).fill(0);
    embedding[axis] = 1;
    return embedding;
  };

  it("persists records and returns workspace-scoped vector matches", async () => {
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
    const workspaceA = await workspaceRepository.create(accountA.id, "Workspace A");
    const workspaceB = await workspaceRepository.create(accountB.id, "Workspace B");

    const documentA = await documentRepository.create({
      workspaceId: workspaceA.id,
      title: "Guide A",
      sourceContent: "The test page explains ingestion.",
      markdownContent: "The test page explains ingestion.",
      status: "ready",
    });
    const documentB = await documentRepository.create({
      workspaceId: workspaceB.id,
      title: "Guide B",
      sourceContent: "Other workspace content.",
      markdownContent: "Other workspace content.",
      status: "ready",
    });

    await chunkRepository.replaceForDocument(documentA.id, [
      {
        id: randomUUID(),
        documentId: documentA.id,
        workspaceId: workspaceA.id,
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
        workspaceId: workspaceB.id,
        chunkIndex: 0,
        content: "This belongs to another workspace.",
        embedding: embeddingOf(1),
        startOffset: 0,
        endOffset: 31,
        createdAt: new Date(),
      },
    ]);

    const matches = await vectorSearch.search({
      workspaceId: workspaceA.id,
      queryEmbedding: embeddingOf(0),
      topK: 5,
      similarityThreshold: 0.1,
    });

    expect(matches).toHaveLength(1);
    expect(matches[0].documentId).toBe(documentA.id);

    await database.query("DELETE FROM chunks WHERE workspace_id = $1 OR workspace_id = $2", [workspaceA.id, workspaceB.id]);
    await database.query("DELETE FROM documents WHERE workspace_id = $1 OR workspace_id = $2", [workspaceA.id, workspaceB.id]);
    await database.query("DELETE FROM workspaces WHERE id = $1 OR id = $2", [workspaceA.id, workspaceB.id]);
    await database.query("DELETE FROM accounts WHERE id = $1 OR id = $2", [accountA.id, accountB.id]);
  });

  it("does not create duplicate default workspaces when migrations rerun", async () => {
    const accountRepository = new AccountRepository(database);
    const account = await accountRepository.create({
      email: `migration-default-${randomUUID()}@example.com`,
      passwordHash: "hash-default",
    });

    await runAllMigrations(database);
    await runAllMigrations(database);

    const workspaces = await workspaceRepository.listByAccountId(account.id);

    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]?.name).toBe("Default");

    await database.query("DELETE FROM workspaces WHERE account_id = $1", [account.id]);
    await database.query("DELETE FROM accounts WHERE id = $1", [account.id]);
  });

  it("stores raw chunk content while generating title-aware retrieval embeddings", async () => {
    const accountRepository = new AccountRepository(database);
    const documentRepository = new DocumentRepository(database);
    const chunkRepository = new ChunkRepository(database);
    const jobRepository = new DocumentProcessingJobRepository(database);
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

    const auditService = new AuditService(createLogger("silent"), noopAuditRepository);
    const retrievalSettingsService = new RetrievalSettingsService(new RetrievalSettingsRepository(database), auditService);
    const embeddingService = new EmbeddingService(embeddingGateway);
    const processingWorker = new DocumentProcessingWorker(
      documentRepository,
      jobRepository,
      new DocumentProcessingService(
        documentRepository,
        chunkRepository,
        embeddingService,
        auditService,
        retrievalSettingsService,
        new ChunkingStrategyRegistry([new FixedWindowChunkingStrategy()]),
      ),
      auditService,
      createLogger("silent"),
    );
    const ingestionService = new DocumentIngestionService(
      documentRepository,
      auditService,
    );

    const account = await accountRepository.create({
      email: `title-aware-${randomUUID()}@example.com`,
      passwordHash: "hash-a",
    });
    const workspace = await workspaceRepository.create(account.id, "Test Workspace");

    const sessionCookie = await ingestionService.ingest({
      workspaceId: workspace.id,
      title: "Session Cookie",
      content: "Used for account registration and bearer token issuance.",
    });
    const auditEvents = await ingestionService.ingest({
      workspaceId: workspace.id,
      title: "Audit Events",
      content: "Used for recording security-relevant activity.",
    });

    await processingWorker.runOnce();
    await processingWorker.runOnce();

    expect(capturedTexts.some((text) => text.startsWith("Title: Session Cookie"))).toBe(true);

    const storedChunks = await database.query<{ content: string }>(
      "SELECT content FROM chunks WHERE document_id = $1 ORDER BY chunk_index ASC",
      [sessionCookie.documentId],
    );
    expect(storedChunks[0]?.content).toContain("Used for account registration");
    expect(storedChunks[0]?.content).not.toContain("Title:");

    const matches = await vectorSearch.search({
      workspaceId: workspace.id,
      queryEmbedding: embeddingOf(0),
      topK: 5,
      similarityThreshold: 0.1,
    });

    expect(matches[0]?.title).toBe("Session Cookie");
    expect(matches[0]?.content).toContain("Used for account registration");

    await database.query("DELETE FROM chunks WHERE workspace_id = $1", [workspace.id]);
    await database.query("DELETE FROM documents WHERE workspace_id = $1", [workspace.id]);
    await database.query("DELETE FROM workspaces WHERE id = $1", [workspace.id]);
    await database.query("DELETE FROM accounts WHERE id = $1", [account.id]);
    expect(auditEvents.status).toBe("queued");
  });

  it("deletes documents only within the matching workspace scope and cascades chunks", async () => {
    const accountRepository = new AccountRepository(database);
    const documentRepository = new DocumentRepository(database);
    const chunkRepository = new ChunkRepository(database);

    const ownerAccount = await accountRepository.create({
      email: `delete-owner-${randomUUID()}@example.com`,
      passwordHash: "hash-owner",
    });
    const otherAccount = await accountRepository.create({
      email: `delete-other-${randomUUID()}@example.com`,
      passwordHash: "hash-other",
    });
    const ownerWorkspace = await workspaceRepository.create(ownerAccount.id, "Owner Workspace");
    const otherWorkspace = await workspaceRepository.create(otherAccount.id, "Other Workspace");

    const ownerDocument = await documentRepository.create({
      workspaceId: ownerWorkspace.id,
      title: "Owner guide",
      sourceContent: "Owner content",
      markdownContent: "Owner content",
      status: "ready",
    });
    const otherDocument = await documentRepository.create({
      workspaceId: otherWorkspace.id,
      title: "Other guide",
      sourceContent: "Other content",
      markdownContent: "Other content",
      status: "ready",
    });

    await chunkRepository.replaceForDocument(ownerDocument.id, [
      {
        id: randomUUID(),
        documentId: ownerDocument.id,
        workspaceId: ownerWorkspace.id,
        chunkIndex: 0,
        content: "Owner chunk",
        embedding: embeddingOf(0),
        startOffset: 0,
        endOffset: 10,
        createdAt: new Date(),
      },
    ]);

    const deniedDelete = await documentRepository.deleteByIdAndWorkspaceId(ownerDocument.id, otherWorkspace.id);
    expect(deniedDelete).toBe(false);

    const permittedDelete = await documentRepository.deleteByIdAndWorkspaceId(ownerDocument.id, ownerWorkspace.id);
    expect(permittedDelete).toBe(true);

    const deletedDocument = await documentRepository.findByIdAndWorkspaceId(ownerDocument.id, ownerWorkspace.id);
    expect(deletedDocument).toBeNull();

    const ownerChunkRows = await database.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM chunks WHERE document_id = $1",
      [ownerDocument.id],
    );
    expect(ownerChunkRows[0]?.count).toBe("0");

    const survivingDocument = await documentRepository.findByIdAndWorkspaceId(otherDocument.id, otherWorkspace.id);
    expect(survivingDocument).not.toBeNull();

    await database.query("DELETE FROM documents WHERE workspace_id = $1 OR workspace_id = $2", [ownerWorkspace.id, otherWorkspace.id]);
    await database.query("DELETE FROM workspaces WHERE id = $1 OR id = $2", [ownerWorkspace.id, otherWorkspace.id]);
    await database.query("DELETE FROM accounts WHERE id = $1 OR id = $2", [ownerAccount.id, otherAccount.id]);
  });

  it("persists uploaded document source metadata and derived content updates", async () => {
    const accountRepository = new AccountRepository(database);
    const documentRepository = new DocumentRepository(database);

    const account = await accountRepository.create({
      email: `imported-source-${randomUUID()}@example.com`,
      passwordHash: "hash-source",
    });
    const workspace = await workspaceRepository.create(account.id, "Imported Workspace");

    const document = await documentRepository.create({
      workspaceId: workspace.id,
      title: "Imported notes",
      sourceContent: "",
      markdownContent: "",
      status: "queued",
      sourceKind: "uploaded_file",
      sourceFilename: "notes.txt",
      sourceMimeType: "text/plain",
      sourceStorageBucket: "test-bucket",
      sourceStorageObject: "workspaces/test/documents/notes.txt",
      sourceStorageGeneration: "1",
      sourceSizeBytes: 12,
    });

    expect(document.sourceKind).toBe("uploaded_file");
    expect(document.sourceStorageObject).toBe("workspaces/test/documents/notes.txt");

    const updated = await documentRepository.updateDerivedContentForRevision({
      documentId: document.id,
      workspaceId: workspace.id,
      revision: document.revision,
      sourceContent: "Imported body",
      markdownContent: "Imported body",
    });

    expect(updated?.sourceContent).toBe("Imported body");

    const persisted = await documentRepository.findByIdAndWorkspaceId(document.id, workspace.id);
    expect(persisted).toMatchObject({
      sourceKind: "uploaded_file",
      sourceFilename: "notes.txt",
      sourceMimeType: "text/plain",
      sourceStorageBucket: "test-bucket",
      sourceStorageObject: "workspaces/test/documents/notes.txt",
      sourceStorageGeneration: "1",
      sourceSizeBytes: 12,
      sourceContent: "Imported body",
    });

    const deleted = await documentRepository.deleteByIdAndWorkspaceId(document.id, workspace.id);
    expect(deleted).toBe(true);

    await database.query("DELETE FROM workspaces WHERE id = $1", [workspace.id]);
    await database.query("DELETE FROM accounts WHERE id = $1", [account.id]);
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
          lexicalCandidateCount: 5,
          normalizedCandidateCount: 14,
          finalContextCount: 4,
          parsedQuery: {
            semanticQuery: "retreats",
            lexicalQuery: "retreats",
            constraints: [
              {
                family: "location",
                operator: "match",
                confidence: 0.95,
                summary: "in Estonia",
                sourceText: "in Estonia",
                value: {
                  matchKey: "estonia",
                  displayName: "Estonia",
                },
              },
            ],
          },
          appliedConstraints: [
            {
              family: "location",
              mode: "hard_filter",
              outcome: "applied",
              summary: "in Estonia",
            },
          ],
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
          lexicalCandidateCount: 5,
          normalizedCandidateCount: 14,
          finalContextCount: 4,
          parsedSemanticQuery: "retreats",
          parsedLexicalQuery: "retreats",
          parsedConstraintCount: 1,
          appliedConstraintCount: 1,
          candidateFallbackApplied: false,
          fallbackApplied: true,
        },
      }),
      "audit_event",
    );
  });
});
