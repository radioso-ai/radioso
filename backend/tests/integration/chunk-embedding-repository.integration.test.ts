import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ChunkEmbeddingRepository } from "../../src/db/repositories/chunkEmbeddingRepository.js";
import { EmbeddingProfileRepository } from "../../src/db/repositories/embeddingProfileRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const dimensionsUnderTest = [768, 1536, 3072, 16_000] as const;

describeIntegration("chunk embedding repository (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl as string);
  const profileRepository = new EmbeddingProfileRepository(database.kysely);
  const repository = new ChunkEmbeddingRepository(database.kysely);

  const accountId = randomUUID();
  const workspaceId = randomUUID();

  beforeAll(async () => {
    await database.query(
      "INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)",
      [accountId, "Canonical Embedding Test", `canonical-${accountId}@example.com`, "hash"],
    );
    await database.query(
      "INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)",
      [workspaceId, accountId, "Canonical Embedding Workspace", `canonical-${workspaceId}`],
    );
  });

  beforeEach(async () => {
    await database.query("DELETE FROM vector_index_work WHERE workspace_id = $1", [workspaceId]);
    await database.query("DELETE FROM vector_index_checkpoints WHERE workspace_id = $1", [workspaceId]);
    await database.query("DELETE FROM documents WHERE workspace_id = $1", [workspaceId]);
    await database.query("DELETE FROM workspace_embedding_transitions WHERE workspace_id = $1", [
      workspaceId,
    ]);
    await database.query("DELETE FROM workspace_embedding_profiles WHERE workspace_id = $1", [
      workspaceId,
    ]);
    await database.query(
      `DELETE FROM embedding_spaces
       WHERE id NOT IN (
         SELECT active_embedding_space_id FROM workspace_embedding_profiles
         UNION
         SELECT pending_embedding_space_id FROM workspace_embedding_profiles
         WHERE pending_embedding_space_id IS NOT NULL
       )`,
    );
  });

  afterAll(async () => {
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  const createSpace = async (dimensions: number) =>
    profileRepository.createEmbeddingSpace({
      identityFingerprint: `canonical-space-${workspaceId}-${dimensions}`,
      provider: "openai",
      endpointScopeFingerprint: "canonical-endpoint-scope",
      model: `fixture-${dimensions}`,
      dimensions,
      distanceMetric: "cosine",
      normalization: "provider",
      documentTask: "document",
      queryTask: "query",
      vectorOptions: {},
      modelVersion: null,
    });

  const insertDocumentAndChunk = async () => {
    const documentId = randomUUID();
    const chunkId = randomUUID();
    await database.query(
      `INSERT INTO documents
         (id, workspace_id, title, source_content, markdown_content, status, revision, metadata)
       VALUES ($1, $2, 'Canonical document', 'Canonical content', 'Canonical content',
               'ready', 3, '{}'::jsonb)`,
      [documentId, workspaceId],
    );
    await database.query(
      `INSERT INTO chunks
         (id, document_id, workspace_id, chunk_index, content, search_text,
          start_offset, end_offset, metadata)
       VALUES ($1, $2, $3, 0, 'Canonical content', 'Canonical search text',
               0, 17, '{}'::jsonb)`,
      [chunkId, documentId, workspaceId],
    );
    return { documentId, chunkId };
  };

  it.each(dimensionsUnderTest)(
    "round-trips a %i-dimensional canonical vector in its immutable space",
    async (dimensions) => {
      const space = await createSpace(dimensions);
      const { documentId, chunkId } = await insertDocumentAndChunk();
      const embedding = Array.from(
        { length: dimensions },
        (_, index) => ((index % 101) - 50) / 997,
      );

      const written = await repository.upsert({
        workspaceId,
        chunkId,
        documentId,
        embeddingSpaceId: space.id,
        documentRevision: 3,
        canonicalVersion: "9007199254740993",
        dimensions,
        embedding,
        contentHash: `content-${dimensions}`,
      });
      const stored = await repository.find({
        workspaceId,
        chunkId,
        embeddingSpaceId: space.id,
      });

      expect(written.applied).toBe(true);
      expect(stored).toMatchObject({
        workspaceId,
        chunkId,
        embeddingSpaceId: space.id,
        documentRevision: 3,
        canonicalVersion: "9007199254740993",
        dimensions,
        contentHash: `content-${dimensions}`,
      });
      expect(stored?.embedding).toHaveLength(dimensions);
      expect(stored?.embedding.map(Math.fround)).toEqual(embedding.map(Math.fround));
    },
    30_000,
  );

  it("preserves canonical vector precision instead of projecting to half precision", async () => {
    const space = await createSpace(4);
    const { documentId, chunkId } = await insertDocumentAndChunk();
    const embedding = [
      0.123456789,
      -0.987654321,
      1.0009765625,
      -0.000123456789,
    ];

    await repository.upsert({
      workspaceId,
      chunkId,
      documentId,
      embeddingSpaceId: space.id,
      documentRevision: 3,
      canonicalVersion: "1",
      dimensions: embedding.length,
      embedding,
      contentHash: "precision-content",
    });

    const stored = await repository.find({
      workspaceId,
      chunkId,
      embeddingSpaceId: space.id,
    });

    expect(stored?.embedding.map(Math.fround)).toEqual(embedding.map(Math.fround));
    expect(stored?.embedding[0]).not.toBe(0.12347412109375);
    expect(Math.fround(stored?.embedding[2] ?? 0)).toBe(Math.fround(1.0009765625));
  });

  it("rejects a vector whose dimensions do not match its immutable embedding space", async () => {
    const space = await createSpace(768);
    const { documentId, chunkId } = await insertDocumentAndChunk();

    await expect(
      repository.upsert({
        workspaceId,
        chunkId,
        documentId,
        embeddingSpaceId: space.id,
        documentRevision: 3,
        canonicalVersion: "1",
        dimensions: 3,
        embedding: [0.1, 0.2, 0.3],
        contentHash: "wrong-space",
      }),
    ).rejects.toThrow(/embedding space.*768.*declared dimensions 3/i);

    expect(
      await repository.find({
        workspaceId,
        chunkId,
        embeddingSpaceId: space.id,
      }),
    ).toBeNull();
  });
});
