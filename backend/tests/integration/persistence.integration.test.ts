import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";

import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { ChunkRepository } from "../../src/db/repositories/chunkRepository.js";
import { ConversationRepository } from "../../src/db/repositories/conversationRepository.js";
import { DocumentRepository } from "../../src/db/repositories/documentRepository.js";
import { DocumentProcessingJobRepository } from "../../src/db/repositories/documentProcessingJobRepository.js";
import { IngestionSettingsRepository } from "../../src/db/repositories/ingestionSettingsRepository.js";
import { WorkspaceRepository } from "../../src/db/repositories/workspaceRepository.js";
import { AuditService } from "../../src/modules/audit/services/auditService.js";
import { DocumentIngestionService } from "../../src/modules/documents/services/documentIngestionService.js";
import { DocumentProcessingService } from "../../src/modules/documents/services/documentProcessingService.js";
import { DocumentProcessingWorker } from "../../src/modules/documents/services/documentProcessingWorker.js";
import { ChunkingStrategyRegistry } from "../../src/modules/retrieval/domain/chunking/chunkingStrategyRegistry.js";
import { FixedWindowChunkingStrategy } from "../../src/modules/retrieval/domain/chunking/fixedWindowChunkingStrategy.js";
import { PgVectorSearch } from "../../src/modules/retrieval/infra/vectorSearch.js";
import { AuditEventRepository } from "../../src/db/repositories/auditEventRepository.js";
import { HistoryItemsRepository } from "../../src/db/repositories/historyItemsRepository.js";
import { AuditEventAnalyticsSink } from "../../src/shared/analytics/auditEventAnalyticsSink.js";
import { ProductAnalyticsService } from "../../src/shared/analytics/productAnalyticsService.js";
import { AuditIncidentSink } from "../../src/shared/incidents/auditIncidentSink.js";
import { IncidentReportingService } from "../../src/shared/incidents/incidentReportingService.js";
import { EmbeddingService, type EmbeddingGateway } from "../../src/modules/retrieval/services/embeddingService.js";
import { IngestionSettingsService } from "../../src/modules/settings/services/ingestionSettingsService.js";
import { Database } from "../../src/shared/infra/database.js";
import { createLogger } from "../../src/shared/observability/logger.js";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const canReachIntegrationDatabase = async (databaseUrl?: string): Promise<boolean> => {
  if (!databaseUrl) {
    return false;
  }

  const database = new Database(databaseUrl);

  try {
    await database.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await database.close().catch(() => undefined);
  }
};

const hasReachableIntegrationDatabase = await canReachIntegrationDatabase(integrationDatabaseUrl);

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
  async listChatAnswerEventsByAssistantMessageIds() {
    return [];
  },
  async findLatestChatAnswerEventByConversationId() {
    return null;
  },
  async updateChatAnswerSuggestions() {
    return false;
  },
  async listDocumentSearchEventsByWorkspaceId() {
    return [];
  },
  async listDocumentSearchEventPageByWorkspaceId() {
    return { events: [], total: 0, nextCursor: null, hasMore: false };
  },
  async findDocumentSearchEventBySearchId() {
    return null;
  },
};
const describeIfDatabase = hasReachableIntegrationDatabase ? describe : describe.skip;

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
      name: "Persist A Organization",
      email: `persist-a-${randomUUID()}@example.com`,
      passwordHash: "hash-a",
    });
    const accountB = await accountRepository.create({
      name: "Persist B Organization",
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
      name: "Migration Default Organization",
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

  it("enforces a single open skill intake state for concurrent starts in one conversation", async () => {
    const accountRepository = new AccountRepository(database);
    const conversationRepository = new ConversationRepository(database);
    const account = await accountRepository.create({
      name: "Concurrent Intake Organization",
      email: `concurrent-intake-${randomUUID()}@example.com`,
      passwordHash: "hash-intake",
    });
    const workspace = await workspaceRepository.create(account.id, "Concurrent Intake Workspace");
    const conversation = await conversationRepository.create(workspace.id);
    const skillName = `test.concurrent.${randomUUID()}`;
    const insertOpenState = () => database.query(
      `INSERT INTO skill_intake_states (
         id,
         workspace_id,
         conversation_id,
         skill_name,
         status,
         collected,
         invalid,
         missing,
         expires_at,
         last_prompted_field
       )
       VALUES ($1, $2, $3, $4, 'active', '{}'::jsonb, '{}'::jsonb, ARRAY['email']::text[], NOW() + INTERVAL '15 minutes', 'email')`,
      [randomUUID(), workspace.id, conversation.id, skillName],
    );

    const results = await Promise.allSettled([insertOpenState(), insertOpenState()]);
    const activeRows = await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM skill_intake_states
       WHERE workspace_id = $1
         AND conversation_id = $2
         AND skill_name = $3
         AND status IN ('active', 'paused', 'awaiting_confirmation', 'awaiting_tool')`,
      [workspace.id, conversation.id, skillName],
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(activeRows[0]?.count).toBe("1");

    await database.query("DELETE FROM skill_intake_states WHERE workspace_id = $1", [workspace.id]);
    await database.query("DELETE FROM conversations WHERE workspace_id = $1", [workspace.id]);
    await database.query("DELETE FROM workspaces WHERE account_id = $1", [account.id]);
    await database.query("DELETE FROM accounts WHERE id = $1", [account.id]);
  });

  it("paginates conversations without skipping rows when updated_at ties", async () => {
    const accountRepository = new AccountRepository(database);
    const conversationRepository = new ConversationRepository(database);

    const account = await accountRepository.create({
      name: "Conversation Cursor Organization",
      email: `conversation-cursor-${randomUUID()}@example.com`,
      passwordHash: "hash-conversation",
    });
    const workspace = await workspaceRepository.create(account.id, "Conversation Workspace");

    const sharedUpdatedAt = new Date("2026-01-01T00:00:00.000Z");
    const firstCreatedAt = new Date("2026-01-01T00:00:02.000Z");
    const secondCreatedAt = new Date("2026-01-01T00:00:01.000Z");
    const thirdCreatedAt = new Date("2026-01-01T00:00:00.000Z");

    const firstConversationId = randomUUID();
    const secondConversationId = randomUUID();
    const thirdConversationId = randomUUID();

    await database.query(
      `INSERT INTO conversations (
         id,
         workspace_id,
         source_channel,
         anonymous_session_id,
         created_at,
         updated_at
       )
       VALUES
         ($1, $2, NULL, NULL, $3, $4),
         ($5, $2, NULL, NULL, $6, $4),
         ($7, $2, NULL, NULL, $8, $9)`,
      [
        firstConversationId,
        workspace.id,
        firstCreatedAt,
        sharedUpdatedAt,
        secondConversationId,
        secondCreatedAt,
        thirdConversationId,
        thirdCreatedAt,
        new Date("2025-12-31T23:59:59.000Z"),
      ],
    );

    const firstPage = await conversationRepository.listPageByWorkspaceId(workspace.id, { limit: 1 });
    expect(firstPage.conversations).toHaveLength(1);
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    const secondPage = await conversationRepository.listPageByWorkspaceId(workspace.id, {
      limit: 1,
      cursor: firstPage.nextCursor ?? undefined,
    });
    const thirdPage = await conversationRepository.listPageByWorkspaceId(workspace.id, {
      limit: 1,
      cursor: secondPage.nextCursor ?? undefined,
    });

    expect([
      firstPage.conversations[0]?.id,
      secondPage.conversations[0]?.id,
      thirdPage.conversations[0]?.id,
    ]).toEqual([
      firstConversationId,
      secondConversationId,
      thirdConversationId,
    ]);

    await database.query("DELETE FROM conversations WHERE workspace_id = $1", [workspace.id]);
    await database.query("DELETE FROM workspaces WHERE id = $1", [workspace.id]);
    await database.query("DELETE FROM accounts WHERE id = $1", [account.id]);
  });

  it("orders merged history items by chat updates and search audit timestamps", async () => {
    const accountRepository = new AccountRepository(database);
    const historyItemsRepository = new HistoryItemsRepository(database);

    const account = await accountRepository.create({
      name: "Merged History Organization",
      email: `merged-history-${randomUUID()}@example.com`,
      passwordHash: "hash-merged-history",
    });
    const workspace = await workspaceRepository.create(account.id, "Merged History Workspace");

    const newConversationId = randomUUID();
    const oldConversationId = randomUUID();
    const newSearchId = randomUUID();
    const oldSearchId = randomUUID();

    await database.query(
      `INSERT INTO conversations (
         id,
         workspace_id,
         source_channel,
         anonymous_session_id,
         created_at,
         updated_at
       )
       VALUES
         ($1, $2, NULL, NULL, $3, $4),
         ($5, $2, NULL, NULL, $6, $7)`,
      [
        newConversationId,
        workspace.id,
        new Date("2026-01-01T00:00:00.000Z"),
        new Date("2026-01-04T00:00:00.000Z"),
        oldConversationId,
        new Date("2026-01-01T00:00:00.000Z"),
        new Date("2026-01-02T00:00:00.000Z"),
      ],
    );

    await database.query(
      `INSERT INTO audit_events (
         id,
         account_id,
         workspace_id,
         event_type,
         event_status,
         metadata_json,
         created_at
       )
       VALUES
         ($1, $2, $3, 'document.search', 'success', $4::jsonb, $5),
         ($6, $2, $3, 'document.search', 'success', $7::jsonb, $8)`,
      [
        randomUUID(),
        account.id,
        workspace.id,
        JSON.stringify({ searchId: newSearchId, query: "new search", results: [] }),
        new Date("2026-01-03T00:00:00.000Z"),
        randomUUID(),
        JSON.stringify({ searchId: oldSearchId, query: "old search", results: [] }),
        new Date("2026-01-01T00:00:00.000Z"),
      ],
    );

    const firstWindow = await historyItemsRepository.listPageByWorkspaceId(workspace.id, {
      limit: 2,
      offset: 1,
    });

    expect(firstWindow.total).toBe(4);
    expect(firstWindow.hasMore).toBe(true);
    expect(firstWindow.items.map((item) => `${item.kind}:${item.id}`)).toEqual([
      `search:${newSearchId}`,
      `chat:${oldConversationId}`,
    ]);

    await database.query("DELETE FROM audit_events WHERE workspace_id = $1", [workspace.id]);
    await database.query("DELETE FROM conversations WHERE workspace_id = $1", [workspace.id]);
    await database.query("DELETE FROM workspaces WHERE id = $1", [workspace.id]);
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
    const ingestionSettingsService = new IngestionSettingsService(new IngestionSettingsRepository(database), auditService);
    const embeddingService = new EmbeddingService(embeddingGateway);
    const processingWorker = new DocumentProcessingWorker(
      documentRepository,
      jobRepository,
      new DocumentProcessingService(
        documentRepository,
        chunkRepository,
        embeddingService,
        auditService,
        ingestionSettingsService,
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
      name: "Title Aware Organization",
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
      name: "Delete Owner Organization",
      email: `delete-owner-${randomUUID()}@example.com`,
      passwordHash: "hash-owner",
    });
    const otherAccount = await accountRepository.create({
      name: "Delete Other Organization",
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
      name: "Imported Source Organization",
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

  it("enforces workspace-scoped external document identity uniqueness and supports idempotent queueing", async () => {
    const accountRepository = new AccountRepository(database);
    const documentRepository = new DocumentRepository(database);

    const accountA = await accountRepository.create({
      name: "External Id A Organization",
      email: `external-id-a-${randomUUID()}@example.com`,
      passwordHash: "hash-a",
    });
    const accountB = await accountRepository.create({
      name: "External Id B Organization",
      email: `external-id-b-${randomUUID()}@example.com`,
      passwordHash: "hash-b",
    });
    const workspaceA = await workspaceRepository.create(accountA.id, "External Workspace A");
    const workspaceB = await workspaceRepository.create(accountB.id, "External Workspace B");

    const first = await documentRepository.createAndQueue({
      workspaceId: workspaceA.id,
      title: "Synced A",
      sourceContent: "First content",
      markdownContent: "First content",
      externalDocumentId: "crm-123",
      sourceKind: "inline_text",
    } as any);

    const second = await documentRepository.createAndQueue({
      workspaceId: workspaceA.id,
      title: "Synced A",
      sourceContent: "Second content",
      markdownContent: "Second content",
      externalDocumentId: "crm-123",
      sourceKind: "inline_text",
    } as any);

    const third = await documentRepository.create({
      workspaceId: workspaceB.id,
      title: "Synced B",
      sourceContent: "Other content",
      markdownContent: "Other content",
      status: "ready",
      externalDocumentId: "crm-123",
      sourceKind: "inline_text",
    } as any);

    expect(second.id).toBe(first.id);
    expect(second.revision).toBe(2);
    expect(second.externalDocumentId).toBe("crm-123");
    expect(third.id).not.toBe(first.id);

    await database.query("DELETE FROM document_processing_jobs WHERE workspace_id = $1 OR workspace_id = $2", [
      workspaceA.id,
      workspaceB.id,
    ]);
    await database.query("DELETE FROM documents WHERE workspace_id = $1 OR workspace_id = $2", [workspaceA.id, workspaceB.id]);
    await database.query("DELETE FROM workspaces WHERE id = $1 OR id = $2", [workspaceA.id, workspaceB.id]);
    await database.query("DELETE FROM accounts WHERE id = $1 OR id = $2", [accountA.id, accountB.id]);
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
            constraints: [],
          },
          appliedConstraints: [],
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
          parsedConstraintCount: 0,
          appliedConstraintCount: 0,
          candidateFallbackApplied: false,
          fallbackApplied: true,
        },
      }),
      "audit_event",
    );
  });

  it("persists analytics and incident sink events in audit storage", async () => {
    const accountRepository = new AccountRepository(database);
    const account = await accountRepository.create({
      name: "Analytics Account",
      email: `analytics-${randomUUID()}@example.com`,
      passwordHash: "hash",
    });
    const workspace = await workspaceRepository.create(account.id, "Analytics Workspace");
    const auditRepository = new AuditEventRepository(database);
    const auditService = new AuditService(createLogger("silent"), auditRepository);
    const analyticsService = new ProductAnalyticsService({
      enabled: true,
      logger: createLogger("silent"),
      sinks: [new AuditEventAnalyticsSink(auditService)],
    });
    const incidentService = new IncidentReportingService({
      enabled: true,
      environment: "test",
      logger: createLogger("silent"),
      service: "radioso-api",
      sinks: [new AuditIncidentSink(auditService)],
    });

    await analyticsService.track({
      eventName: "retrieval_settings.updated",
      workspaceId: workspace.id,
      accountId: account.id,
      subjectType: "settings",
      subjectId: workspace.id,
      source: "backend",
    });
    await incidentService.report({
      incidentType: "http.request.unhandled",
      severity: "error",
      correlation: {
        workspaceId: workspace.id,
        accountId: account.id,
      },
      message: "boom",
    });

    const rows = await database.query<{
      event_type: string;
      event_status: string;
      metadata_json: Record<string, unknown>;
    }>(
      `SELECT event_type, event_status, metadata_json
       FROM audit_events
       WHERE workspace_id = $1
         AND event_type IN ('product.analytics', 'incident.recorded')
       ORDER BY created_at ASC`,
      [workspace.id],
    );

    expect(rows).toEqual([
      expect.objectContaining({
        event_type: "product.analytics",
        event_status: "success",
        metadata_json: {
          analytics: expect.objectContaining({
            eventName: "retrieval_settings.updated",
          }),
        },
      }),
      expect.objectContaining({
        event_type: "incident.recorded",
        event_status: "failure",
        metadata_json: {
          incident: expect.objectContaining({
            incidentType: "http.request.unhandled",
          }),
        },
      }),
    ]);

    await database.query("DELETE FROM audit_events WHERE workspace_id = $1", [workspace.id]);
    await database.query("DELETE FROM workspaces WHERE id = $1", [workspace.id]);
    await database.query("DELETE FROM accounts WHERE id = $1", [account.id]);
  });
});
