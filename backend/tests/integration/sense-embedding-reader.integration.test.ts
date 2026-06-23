import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { DocumentRepository } from "../../src/db/repositories/documentRepository.js";
import { WorkspaceRepository } from "../../src/db/repositories/workspaceRepository.js";
import { ChunkRepository } from "../../src/modules/documents/infra/chunkRepository.js";
import { PostgresSenseEmbeddingReader } from "../../src/modules/retrieval/services/senseGroupingService.js";
import { PgVectorChunkStorage } from "../../src/modules/retrieval/infra/chunkVectorStorage.js";
import { Database } from "../../src/shared/infra/database.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";

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
const describeIfDatabase = hasReachableIntegrationDatabase ? describe : describe.skip;

describeIfDatabase("PostgresSenseEmbeddingReader", () => {
  let database: Database;

  beforeAll(async () => {
    database = new Database(integrationDatabaseUrl!);
    await runAllTestMigrations(database);
  });

  afterAll(async () => {
    await database.close();
  });

  // chunks.id is uuid; the read must compare it against a uuid[] bind, not text[].
  // A text[] cast makes Postgres reject the query with "operator does not exist:
  // uuid = text" at execution time, even when no rows match — which broke the
  // retrieval-sense detector before it could ask or pick a sense.
  it("queries chunk embeddings by uuid id without a uuid/text operator error", async () => {
    const reader = new PostgresSenseEmbeddingReader(database.kysely);

    const result = await reader.readChunkEmbeddings({
      workspaceId: randomUUID(),
      chunkIds: [randomUUID(), randomUUID()],
    });

    expect(result.size).toBe(0);
  });

  // Characterizes the vector-as-text read: the pgvector column serializes to the
  // `[a,b,...]` literal and `parsePgVector` maps it back to numbers, scoped to the
  // workspace. This is the behaviour the Kysely + `sql` fragment must preserve.
  it("reads stored chunk embeddings scoped to the workspace", async () => {
    const accountRepository = new AccountRepository(database.kysely);
    const workspaceRepository = new WorkspaceRepository(database.kysely);
    const documentRepository = new DocumentRepository(database.kysely);
    const chunkRepository = new ChunkRepository(database, new PgVectorChunkStorage());

    const account = await accountRepository.create({
      name: "Sense Reader Org",
      email: `sense-reader-${randomUUID()}@example.com`,
      passwordHash: "hash",
    });
    const workspace = await workspaceRepository.create(account.id, "Sense Reader Workspace");
    const otherWorkspace = await workspaceRepository.create(account.id, "Other Workspace");
    const document = await documentRepository.create({
      workspaceId: workspace.id,
      title: "Sense Reader Guide",
      sourceContent: "Sense reader content.",
      markdownContent: "Sense reader content.",
      status: "ready",
    });

    const matchedChunkId = randomUUID();
    const otherChunkId = randomUUID();
    await chunkRepository.replaceForDocument(document.id, [
      {
        id: matchedChunkId,
        documentId: document.id,
        workspaceId: workspace.id,
        chunkIndex: 0,
        content: "The first chunk.",
        embedding: [1, 0, 0],
        embeddingModel: "gemini-embedding-001",
        startOffset: 0,
        endOffset: 16,
        createdAt: new Date(),
      },
    ]);

    const reader = new PostgresSenseEmbeddingReader(database.kysely);

    const result = await reader.readChunkEmbeddings({
      workspaceId: workspace.id,
      chunkIds: [matchedChunkId, otherChunkId],
    });

    expect(result.size).toBe(1);
    expect(result.get(matchedChunkId)).toEqual([1, 0, 0]);

    // Wrong workspace scope returns nothing even for a real chunk id.
    const scoped = await reader.readChunkEmbeddings({
      workspaceId: otherWorkspace.id,
      chunkIds: [matchedChunkId],
    });
    expect(scoped.size).toBe(0);

    await database.query("DELETE FROM chunks WHERE workspace_id = $1", [workspace.id]);
    await database.query("DELETE FROM documents WHERE workspace_id = $1", [workspace.id]);
    await database.query("DELETE FROM workspaces WHERE id = $1 OR id = $2", [workspace.id, otherWorkspace.id]);
    await database.query("DELETE FROM accounts WHERE id = $1", [account.id]);
  });
});
