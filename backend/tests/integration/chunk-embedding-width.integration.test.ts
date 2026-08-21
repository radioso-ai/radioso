import { randomUUID } from "node:crypto";

import { afterAll, beforeEach, expect, it } from "vitest";

import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { DocumentRepository } from "../../src/db/repositories/documentRepository.js";
import { WorkspaceRepository } from "../../src/db/repositories/workspaceRepository.js";
import { ChunkRepository } from "../../src/modules/documents/infra/chunkRepository.js";
import { PgVectorChunkStorage } from "../../src/modules/retrieval/infra/chunkVectorStorage.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

// The chunk inspector reports the embedding width of a chunk. `chunks.embedding` is
// fixed at vector(1536), so reading it is a lie for any workspace on a wider model —
// the canonical row carries the width semantic search actually compares against. This
// covers the SQL against Postgres; the unit test only pins the shape.

const CANONICAL_DIMENSIONS = 3;
const LEGACY_DIMENSIONS = 1536;

const legacyVector = Array.from(
  { length: LEGACY_DIMENSIONS },
  (_, index) => (index === 0 ? 1 : 0),
);

describeIntegration("chunk detail embedding width (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl as string);
  const chunkRepository = new ChunkRepository(database, new PgVectorChunkStorage());

  let accountId: string;
  let workspaceId: string;
  let documentId: string;
  let chunkId: string;
  let activeSpaceId: string;
  let retiredSpaceId: string;

  beforeEach(async () => {
    const account = await new AccountRepository(database.kysely).create({
      name: "Chunk Width Org",
      email: `chunk-width-${randomUUID()}@example.com`,
      passwordHash: "hash",
    });
    accountId = account.id;
    const workspace = await new WorkspaceRepository(database.kysely)
      .create(accountId, "Chunk Width Workspace");
    workspaceId = workspace.id;
    const document = await new DocumentRepository(database.kysely).create({
      workspaceId,
      title: "Chunk Width Guide",
      sourceContent: "Body.",
      markdownContent: "Body.",
      status: "ready",
    });
    documentId = document.id;

    chunkId = randomUUID();
    await chunkRepository.replaceForDocument(documentId, [{
      id: chunkId,
      documentId,
      workspaceId,
      chunkIndex: 0,
      content: "The only chunk.",
      embedding: legacyVector,
      embeddingModel: "text-embedding-3-small",
      startOffset: 0,
      endOffset: 15,
      createdAt: new Date(),
    }]);

    activeSpaceId = randomUUID();
    retiredSpaceId = randomUUID();
    for (const spaceId of [activeSpaceId, retiredSpaceId]) {
      await database.query(
        `INSERT INTO embedding_spaces
           (id, identity_fingerprint, endpoint_scope_fingerprint, provider, model, dimensions, distance_metric, normalization, status)
         VALUES ($1, $2, $3, 'openai', 'text-embedding-3-small', ${CANONICAL_DIMENSIONS}, 'cosine', 'none', 'active')`,
        [spaceId, `width-fp-${spaceId}`, `width-scope-${spaceId}`],
      );
    }
    await database.query(
      `INSERT INTO workspace_embedding_profiles (workspace_id, active_embedding_space_id)
       VALUES ($1, $2)`,
      [workspaceId, activeSpaceId],
    );
  });

  afterAll(async () => {
    await database.close().catch(() => undefined);
  });

  const insertCanonical = async (spaceId: string): Promise<void> => {
    await database.query(
      `INSERT INTO chunk_embeddings
         (workspace_id, chunk_id, embedding_space_id, document_revision, canonical_version, dimensions, embedding, content_hash)
       VALUES ($1, $2, $3, 1, 1, ${CANONICAL_DIMENSIONS}, '[0.1,0.2,0.3]'::vector, 'hash')`,
      [workspaceId, chunkId, spaceId],
    );
  };

  const readWidth = async (): Promise<number | null> => {
    const detail = await chunkRepository.findByIdForDocument({ chunkId, documentId, workspaceId });
    expect(detail).not.toBeNull();
    return detail?.embeddingDimensions ?? null;
  };

  it("reports the canonical width rather than the legacy column's fixed 1536", async () => {
    await insertCanonical(activeSpaceId);

    expect(await readWidth()).toBe(CANONICAL_DIMENSIONS);
  });

  it("falls back to the legacy width for a chunk with no canonical row", async () => {
    // Mid-backfill, an uncovered chunk still reports something rather than a blank.
    expect(await readWidth()).toBe(LEGACY_DIMENSIONS);
  });

  it("ignores a canonical row filed under a space the workspace has moved off", async () => {
    await insertCanonical(retiredSpaceId);

    // A leftover row from an earlier model is not what search compares against.
    expect(await readWidth()).toBe(LEGACY_DIMENSIONS);
  });

  it("ignores an active-space canonical row from an older document revision", async () => {
    await insertCanonical(activeSpaceId);
    await database.query("UPDATE documents SET revision = 2 WHERE id = $1", [documentId]);

    // Reprocessing advances the document before its replacement chunks are published.
    // Search rejects the old canonical row during that window, so the inspector must too.
    expect(await readWidth()).toBe(LEGACY_DIMENSIONS);
  });
});
