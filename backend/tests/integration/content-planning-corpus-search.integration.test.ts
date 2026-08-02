import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ContentPlanningCorpusSearchRepository } from "../../src/db/repositories/contentPlanningCorpusSearchRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const canReach = async (url?: string): Promise<boolean> => {
  if (!url) return false;
  const database = new Database(url);
  try {
    await database.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await database.close().catch(() => undefined);
  }
};

const describeIfDatabase = await canReach(integrationDatabaseUrl) ? describe : describe.skip;

describeIfDatabase("ContentPlanningCorpusSearchRepository", () => {
  let database: Database;
  let repository: ContentPlanningCorpusSearchRepository;
  const accountIds: string[] = [];

  beforeAll(async () => {
    database = new Database(integrationDatabaseUrl!);
    await runAllTestMigrations(database);
    repository = new ContentPlanningCorpusSearchRepository(database.kysely);
  });

  afterAll(async () => {
    if (accountIds.length > 0) {
      await database.execute("DELETE FROM accounts WHERE id = ANY($1::uuid[])", [accountIds]);
    }
    await database.close();
  });

  it("searches only current retrievable documents in the authorized workspace and embedding space", async () => {
    const accountId = randomUUID();
    const workspaceId = randomUUID();
    const foreignWorkspaceId = randomUUID();
    const embeddingSpaceId = randomUUID();
    accountIds.push(accountId);
    await database.execute(
      "INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, 'Corpus', $2, 'hash')",
      [accountId, `corpus-${accountId}@example.com`],
    );
    await database.execute(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES
       ($1, $3, 'Corpus workspace', $4),
       ($2, $3, 'Foreign workspace', $5)`,
      [workspaceId, foreignWorkspaceId, accountId, `corpus-${workspaceId}`, `foreign-${foreignWorkspaceId}`],
    );
    await database.execute(
      `INSERT INTO embedding_spaces (
         id, identity_fingerprint, provider, endpoint_scope_fingerprint, model,
         dimensions, distance_metric, normalization
       ) VALUES ($1, $2, 'test', $3, 'corpus-model', 3, 'cosine', 'unit')`,
      [embeddingSpaceId, `corpus-space-${embeddingSpaceId}`, `corpus-endpoint-${embeddingSpaceId}`],
    );

    const documents = [
      { workspaceId, status: "ready", enabled: true, expiresAt: null, vector: [1, 0, 0] },
      { workspaceId, status: "ready", enabled: false, expiresAt: null, vector: [1, 0, 0] },
      { workspaceId, status: "ready", enabled: true, expiresAt: "2026-01-01T00:00:00.000Z", vector: [1, 0, 0] },
      { workspaceId, status: "processing", enabled: true, expiresAt: null, vector: [1, 0, 0] },
      { workspaceId: foreignWorkspaceId, status: "ready", enabled: true, expiresAt: null, vector: [1, 0, 0] },
    ] as const;
    const documentIds: string[] = [];
    for (const [index, document] of documents.entries()) {
      const documentId = randomUUID();
      const chunkId = randomUUID();
      documentIds.push(documentId);
      await database.execute(
        `INSERT INTO documents (
           id, workspace_id, title, source_content, markdown_content, status,
           revision, metadata, retrieval_enabled, retrieval_expires_at
         ) VALUES ($1, $2, $3, 'source', 'markdown', $4, 1, '{}'::jsonb, $5, $6)`,
        [documentId, document.workspaceId, `Document ${index + 1}`, document.status, document.enabled, document.expiresAt],
      );
      await database.execute(
        `INSERT INTO chunks (id, workspace_id, document_id, chunk_index, content)
         VALUES ($1, $2, $3, 0, 'content')`,
        [chunkId, document.workspaceId, documentId],
      );
      await database.execute(
        `INSERT INTO chunk_embeddings (
           workspace_id, chunk_id, embedding_space_id, document_revision,
           canonical_version, dimensions, embedding, content_hash
         ) VALUES ($1, $2, $3, 1, 1, 3, $4::vector, $5)`,
        [document.workspaceId, chunkId, embeddingSpaceId, `[${document.vector.join(",")}]`, `hash-${index}`],
      );
    }

    const result = await repository.findRelatedDocuments({
      workspaceId,
      embeddingSpaceId,
      centroid: [1, 0, 0],
      limit: 20,
    });

    expect(result).toEqual([expect.objectContaining({
      id: documentIds[0],
      title: "Document 1",
      possibleRelevance: expect.closeTo(1, 8),
    })]);
  });
});
