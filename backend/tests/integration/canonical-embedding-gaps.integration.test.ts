import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { DocumentProcessingJobRepository } from "../../src/db/repositories/documentProcessingJobRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

// Coverage reconciliation runs only when a document is ingested, so a workspace that
// has not ingested since canonical embeddings shipped keeps its vectors in the legacy
// column alone. This query is how an operator sees that backlog before running the
// one-time backfill.

describeIntegration("canonical embedding coverage gaps (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl as string);
  const repository = new DocumentProcessingJobRepository(database.kysely);

  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const spaceId = randomUUID();
  let documentId: string;

  beforeAll(async () => {
    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [accountId, "Coverage Gap Co", `gap-${accountId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [workspaceId, accountId, "Coverage Gap Workspace", `gap-route-${workspaceId}`],
    );
    await database.query(
      `INSERT INTO embedding_spaces
         (id, identity_fingerprint, endpoint_scope_fingerprint, provider, model, dimensions, distance_metric, normalization, status)
       VALUES ($1, $2, $3, 'openai', 'text-embedding-3-small', 1536, 'cosine', 'none', 'active')`,
      [spaceId, `gap-fp-${spaceId}`, `gap-scope-${spaceId}`],
    );
  });

  beforeEach(async () => {
    await database.query("DELETE FROM documents WHERE workspace_id = $1", [workspaceId]);
    documentId = randomUUID();
    await database.query(
      `INSERT INTO documents (id, workspace_id, title, source_content, markdown_content, status, revision, metadata)
       VALUES ($1, $2, 'Doc', 'content', 'content', 'ready', 1, '{}'::jsonb)`,
      [documentId, workspaceId],
    );
  });

  afterAll(async () => {
    await database.query("DELETE FROM embedding_spaces WHERE id = $1", [spaceId])
      .catch(() => undefined);
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  const insertChunk = async (chunkIndex: number): Promise<string> => {
    const chunkId = randomUUID();
    await database.query(
      `INSERT INTO chunks (id, document_id, workspace_id, chunk_index, content, search_text, embedding, start_offset, end_offset, metadata)
       VALUES ($1, $2, $3, $4, 'chunk text', 'chunk text',
               (SELECT array_agg(0.1)::vector FROM generate_series(1, 1536)), 0, 10, '{}'::jsonb)`,
      [chunkId, documentId, workspaceId, chunkIndex],
    );
    return chunkId;
  };

  const gapFor = async (): Promise<number> => {
    const gaps = await repository.listWorkspaceCanonicalEmbeddingGaps();
    return gaps.find((gap) => gap.workspaceId === workspaceId)?.missingChunks ?? 0;
  };

  it("counts chunks that have no canonical embedding row", async () => {
    await insertChunk(0);
    await insertChunk(1);

    expect(await gapFor()).toBe(2);
  });

  it("stops counting a chunk once it is projected into chunk_embeddings", async () => {
    const chunkId = await insertChunk(0);
    await insertChunk(1);

    await database.query(
      `INSERT INTO chunk_embeddings
         (workspace_id, chunk_id, embedding_space_id, document_revision, canonical_version, dimensions, embedding, content_hash)
       VALUES ($1, $2, $3, 1, 1, 1536,
               (SELECT array_agg(0.1)::vector FROM generate_series(1, 1536)), 'hash')`,
      [workspaceId, chunkId, spaceId],
    );

    expect(await gapFor()).toBe(1);
  });

  it("omits a workspace entirely once every chunk is projected", async () => {
    const chunkId = await insertChunk(0);
    await database.query(
      `INSERT INTO chunk_embeddings
         (workspace_id, chunk_id, embedding_space_id, document_revision, canonical_version, dimensions, embedding, content_hash)
       VALUES ($1, $2, $3, 1, 1, 1536,
               (SELECT array_agg(0.1)::vector FROM generate_series(1, 1536)), 'hash')`,
      [workspaceId, chunkId, spaceId],
    );

    const gaps = await repository.listWorkspaceCanonicalEmbeddingGaps();
    expect(gaps.some((gap) => gap.workspaceId === workspaceId)).toBe(false);
  });
});
