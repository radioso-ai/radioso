import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

import { VectorIndexWorkRepository } from "../../src/db/repositories/vectorIndexWorkRepository.js";
import {
  appendVectorFilterUpdatesForDocument,
} from "../../src/db/repositories/vectorIndexWorkRepository.js";
import {
  insertCanonicalChunkEmbeddingsForDocumentRevision,
} from "../../src/db/repositories/chunkEmbeddingRepository.js";
import type { EmbeddingSpaceRecord } from "../../src/modules/embeddingProfiles/contracts/repositories.js";
import type {
  EmbeddingSpaceRef,
  VectorIndexRecord,
} from "../../src/modules/retrieval/domain/vectorAdapter.js";
import {
  VectorIndexReconciler,
} from "../../src/modules/retrieval/services/vectorIndexReconciler.js";
import { PgVectorAdapter } from "../../src/modules/retrieval/infra/pgVectorAdapter.js";
import {
  VectorIndexRebuildService,
  type CanonicalVectorRebuildSourcePort,
} from "../../src/modules/retrieval/services/vectorIndexRebuildService.js";
import { Database } from "../../src/shared/infra/database.js";
import { InMemoryVectorAdapter } from "../support/inMemoryVectorAdapter.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } =
  await resolveIntegrationDatabase();

const now = new Date("2100-01-01T00:00:00.000Z");

describeIntegration("vector index reconciliation (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const repository = new VectorIndexWorkRepository(database.kysely);
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const spaceId = randomUUID();
  const space: EmbeddingSpaceRef = {
    id: spaceId,
    dimensions: 2,
    distanceMetric: "cosine",
  };

  beforeAll(async () => {
    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash)
       VALUES ($1, 'Vector reconciliation', $2, 'hash')`,
      [accountId, `vector-reconciliation-${accountId}@example.com`],
    );
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key)
       VALUES ($1, $2, 'Vector reconciliation', $3)`,
      [workspaceId, accountId, `vector-reconciliation-${workspaceId}`],
    );
    await database.query(
      `INSERT INTO embedding_spaces (
         id, identity_fingerprint, provider, endpoint_scope_fingerprint,
         model, dimensions, distance_metric, normalization
       )
       VALUES ($1, $2, 'openai', $3, 'test-model', 2, 'cosine', 'provider_unit')`,
      [spaceId, `vector-reconciliation-${spaceId}`, `scope-${spaceId}`],
    );
  });

  beforeEach(async () => {
    await database.query(
      "DELETE FROM vector_index_checkpoints WHERE workspace_id = $1",
      [workspaceId],
    );
    await database.query(
      "DELETE FROM vector_index_work WHERE workspace_id = $1",
      [workspaceId],
    );
  });

  afterAll(async () => {
    await database.query("DELETE FROM workspaces WHERE id = $1", [workspaceId])
      .catch(() => undefined);
    await database.query("DELETE FROM embedding_spaces WHERE id = $1", [spaceId])
      .catch(() => undefined);
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId])
      .catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  const appendUpsert = async (
    chunkId = randomUUID(),
    canonicalVersion = "1",
  ) => repository.append({
    workspaceId,
    embeddingSpaceId: spaceId,
    chunkId,
    documentId: randomUUID(),
    operation: "upsert",
    canonicalVersion,
    payload: {
      dimensions: 2,
      distanceMetric: "cosine",
      vector: [1, 0],
      sourceId: null,
      metadata: { state: "current" },
      retrievalEnabled: true,
      retrievalExpiresAt: null,
    },
  });

  it("claims in sequence, reclaims expired leases, retries with backoff, and dead-letters bounded failures", async () => {
    const first = await appendUpsert(randomUUID(), "1");
    const second = await appendUpsert(randomUUID(), "1");

    const claimed = await repository.claimBatch({
      limit: 1,
      now,
      leaseMs: 1_000,
    });
    expect(claimed.map((work) => work.id)).toEqual([first.work.id]);
    expect(claimed[0]).toMatchObject({
      status: "processing",
      attemptCount: 1,
    });
    const secondClaim = await repository.claimBatch({
      limit: 1,
      now: new Date(now.getTime() + 500),
      leaseMs: 1_000,
    });
    expect(secondClaim).toMatchObject([{ id: second.work.id }]);
    await repository.markCompleted(second.work.id);

    const reclaimed = await repository.claimBatch({
      limit: 1,
      now: new Date(now.getTime() + 1_001),
      leaseMs: 1_000,
    });
    expect(reclaimed[0]).toMatchObject({
      id: first.work.id,
      attemptCount: 2,
    });
    await expect(repository.markFailed({
      id: first.work.id,
      errorCode: "adapter_unavailable",
      retryAt: new Date(now.getTime() + 5_000),
      maxAttempts: 3,
      backendKey: "pgvector",
      workspaceId,
      embeddingSpaceId: spaceId,
      chunkId: first.work.chunkId,
      caughtUpReadiness: "exact_fallback",
    })).resolves.toEqual({
      disposition: "retry_scheduled",
      checkpoint: null,
    });
    await expect(repository.claimBatch({
      limit: 10,
      now: new Date(now.getTime() + 4_999),
      leaseMs: 1_000,
    })).resolves.toEqual([]);

    const finalClaim = await repository.claimBatch({
      limit: 10,
      now: new Date(now.getTime() + 5_000),
      leaseMs: 1_000,
    });
    expect(finalClaim[0]).toMatchObject({
      id: first.work.id,
      attemptCount: 3,
    });
    await expect(repository.markFailed({
      id: first.work.id,
      errorCode: "adapter_unavailable",
      retryAt: new Date(now.getTime() + 10_000),
      maxAttempts: 3,
      backendKey: "pgvector",
      workspaceId,
      embeddingSpaceId: spaceId,
      chunkId: first.work.chunkId,
      caughtUpReadiness: "exact_fallback",
    })).resolves.toEqual({
      disposition: "dead_lettered",
      checkpoint: null,
    });
    await expect(repository.claimBatch({
      limit: 10,
      now: new Date(now.getTime() + 20_000),
      leaseMs: 1_000,
    })).resolves.toEqual([]);
  });

  it("delivers portable mutations, acknowledges work, and advances contiguous readiness", async () => {
    const adapter = new InMemoryVectorAdapter();
    const appended = await appendUpsert();
    const storedSpace = embeddingSpaceRecord(space);
    const onCheckpointAdvanced = vi.fn();
    const reconciler = new VectorIndexReconciler({
      adapter,
      backendKey: "in-memory",
      clock: () => now,
      repository,
      spaces: {
        async findEmbeddingSpaceById(id) {
          return id === spaceId ? storedSpace : null;
        },
      },
      batchSize: 10,
      leaseMs: 1_000,
      maxAttempts: 3,
      retryDelayMs: 5_000,
      resolveCaughtUpReadiness: async () => "ready",
      onCheckpointAdvanced,
    });

    await expect(reconciler.runOnce()).resolves.toBe(true);
    await expect(adapter.search.search({
      workspaceId,
      space,
      queryVector: [1, 0],
      topK: 10,
      minimumScore: -1,
      filter: {},
    })).resolves.toMatchObject([
      {
        chunkId: appended.work.chunkId,
        embeddingSpaceId: spaceId,
        version: "1",
      },
    ]);
    await expect(repository.findCheckpoint({
      backendKey: "in-memory",
      workspaceId,
      embeddingSpaceId: spaceId,
    })).resolves.toMatchObject({
      acknowledgedSequence: appended.work.sequence,
      readiness: "ready",
    });
    await expect(reconciler.getLag({
      workspaceId,
      embeddingSpaceId: spaceId,
    })).resolves.toMatchObject({
      requiredSequence: appended.work.sequence,
      acknowledgedSequence: appended.work.sequence,
      pendingCount: 0,
      deadLetterCount: 0,
      readiness: "ready",
    });
    expect(onCheckpointAdvanced).toHaveBeenCalledOnce();
    expect(onCheckpointAdvanced).toHaveBeenCalledWith({
      workspaceId,
      embeddingSpaceId: spaceId,
      readiness: "ready",
    });
  });

  it("skips an obsolete missing upsert when a later tombstone can advance the checkpoint", async () => {
    const chunkId = randomUUID();
    const upsert = await appendUpsert(chunkId, "1");
    const tombstone = await repository.append({
      workspaceId,
      embeddingSpaceId: spaceId,
      chunkId,
      documentId: upsert.work.documentId,
      operation: "delete",
      canonicalVersion: "2",
      payload: {},
    });
    const onCheckpointAdvanced = vi.fn();
    const reconciler = new VectorIndexReconciler({
      adapter: new PgVectorAdapter(database),
      backendKey: "pgvector",
      clock: () => now,
      repository,
      spaces: {
        async findEmbeddingSpaceById(id) {
          return id === spaceId ? embeddingSpaceRecord(space) : null;
        },
      },
      batchSize: 10,
      leaseMs: 1_000,
      maxAttempts: 3,
      retryDelayMs: 5_000,
      resolveCaughtUpReadiness: async () => "exact_fallback",
      onCheckpointAdvanced,
    });

    await expect(reconciler.runOnce()).resolves.toBe(true);

    await expect(repository.findCheckpoint({
      backendKey: "pgvector",
      workspaceId,
      embeddingSpaceId: spaceId,
    })).resolves.toMatchObject({
      acknowledgedSequence: tombstone.work.sequence,
      readiness: "exact_fallback",
    });
    await expect(repository.getLag({
      backendKey: "pgvector",
      workspaceId,
      embeddingSpaceId: spaceId,
    })).resolves.toMatchObject({
      requiredSequence: tombstone.work.sequence,
      acknowledgedSequence: tombstone.work.sequence,
      pendingCount: 0,
      deadLetterCount: 0,
      readiness: "exact_fallback",
    });
    expect(onCheckpointAdvanced).toHaveBeenCalledOnce();
  });

  it.each(["before_append", "after_append"] as const)(
    "retires an older dead letter %s without marking caught up before its tombstone completes",
    async (deadLetterOrder) => {
      const chunkId = randomUUID();
      const upsert = await appendUpsert(chunkId, "1");
      await expect(repository.claimBatch({
        limit: 1,
        now,
        leaseMs: 1_000,
      })).resolves.toMatchObject([{ id: upsert.work.id }]);

      const deadLetterUpsert = () => repository.markFailed({
        id: upsert.work.id,
        errorCode: "adapter_unavailable",
        retryAt: new Date(now.getTime() + 5_000),
        maxAttempts: 1,
        backendKey: "pgvector",
        workspaceId,
        embeddingSpaceId: spaceId,
        chunkId,
        caughtUpReadiness: "exact_fallback",
      });
      if (deadLetterOrder === "before_append") {
        await expect(deadLetterUpsert()).resolves.toMatchObject({
          disposition: "dead_lettered",
          checkpoint: null,
        });
      }
      const tombstone = await repository.append({
        workspaceId,
        embeddingSpaceId: spaceId,
        chunkId,
        documentId: upsert.work.documentId,
        operation: "delete",
        canonicalVersion: "2",
        payload: {},
      });
      if (deadLetterOrder === "after_append") {
        await expect(deadLetterUpsert()).resolves.toMatchObject({
          disposition: "superseded",
          checkpoint: {
            acknowledgedSequence: upsert.work.sequence,
            readiness: "building",
          },
        });
      }

      const checkpointBeforeTombstone = repository.findCheckpoint({
        backendKey: "pgvector",
        workspaceId,
        embeddingSpaceId: spaceId,
      });
      if (deadLetterOrder === "before_append") {
        await expect(checkpointBeforeTombstone).resolves.toBeNull();
      } else {
        await expect(checkpointBeforeTombstone).resolves.toMatchObject({
          acknowledgedSequence: upsert.work.sequence,
          readiness: "building",
        });
      }

      const onCheckpointAdvanced = vi.fn();
      const reconciler = new VectorIndexReconciler({
        adapter: new PgVectorAdapter(database),
        backendKey: "pgvector",
        clock: () => now,
        repository,
        spaces: {
          async findEmbeddingSpaceById(id) {
            return id === spaceId ? embeddingSpaceRecord(space) : null;
          },
        },
        batchSize: 10,
        leaseMs: 1_000,
        maxAttempts: 3,
        retryDelayMs: 5_000,
        resolveCaughtUpReadiness: async () => "exact_fallback",
        onCheckpointAdvanced,
      });

      await expect(reconciler.runOnce()).resolves.toBe(true);

      const statuses = await database.query<{
        id: string;
        status: string;
      }>(
        `SELECT id, status
         FROM vector_index_work
         WHERE id = ANY($1::uuid[])
         ORDER BY sequence`,
        [[upsert.work.id, tombstone.work.id]],
      );
      expect(statuses).toEqual([
        { id: upsert.work.id, status: "completed" },
        { id: tombstone.work.id, status: "completed" },
      ]);
      await expect(repository.findCheckpoint({
        backendKey: "pgvector",
        workspaceId,
        embeddingSpaceId: spaceId,
      })).resolves.toMatchObject({
        acknowledgedSequence: tombstone.work.sequence,
        readiness: "exact_fallback",
      });
      expect(onCheckpointAdvanced).toHaveBeenCalledOnce();
    },
  );

  it("recalculates readiness when an older failure commits after its tombstone was acknowledged", async () => {
    const chunkId = randomUUID();
    const upsert = await appendUpsert(chunkId, "1");
    await expect(repository.claimBatch({
      limit: 1,
      now,
      leaseMs: 1_000,
    })).resolves.toMatchObject([{ id: upsert.work.id }]);
    const tombstone = await repository.append({
      workspaceId,
      embeddingSpaceId: spaceId,
      chunkId,
      documentId: upsert.work.documentId,
      operation: "delete",
      canonicalVersion: "2",
      payload: {},
    });
    await expect(repository.claimBatch({
      limit: 1,
      now,
      leaseMs: 1_000,
    })).resolves.toMatchObject([{ id: tombstone.work.id }]);

    await expect(repository.markCompletedAndAdvanceCheckpoint({
      id: tombstone.work.id,
      backendKey: "pgvector",
      workspaceId,
      embeddingSpaceId: spaceId,
      chunkId,
      caughtUpReadiness: "exact_fallback",
    })).resolves.toMatchObject({
      acknowledgedSequence: "0",
      readiness: "building",
    });

    await expect(repository.markFailed({
      id: upsert.work.id,
      errorCode: "adapter_unavailable",
      retryAt: new Date(now.getTime() + 5_000),
      maxAttempts: 1,
      backendKey: "pgvector",
      workspaceId,
      embeddingSpaceId: spaceId,
      chunkId,
      caughtUpReadiness: "exact_fallback",
    })).resolves.toMatchObject({
      disposition: "superseded",
      checkpoint: {
        acknowledgedSequence: tombstone.work.sequence,
        readiness: "exact_fallback",
      },
    });

    const statuses = await database.query<{
      id: string;
      status: string;
    }>(
      `SELECT id, status
       FROM vector_index_work
       WHERE id = ANY($1::uuid[])
       ORDER BY sequence`,
      [[upsert.work.id, tombstone.work.id]],
    );
    expect(statuses).toEqual([
      { id: upsert.work.id, status: "completed" },
      { id: tombstone.work.id, status: "completed" },
    ]);
    await expect(repository.findCheckpoint({
      backendKey: "pgvector",
      workspaceId,
      embeddingSpaceId: spaceId,
    })).resolves.toMatchObject({
      acknowledgedSequence: tombstone.work.sequence,
      readiness: "exact_fallback",
    });
  });

  it("notifies only caught-up checkpoints and preserves them when notification fails", async () => {
    const adapter = new InMemoryVectorAdapter();
    const storedSpace = embeddingSpaceRecord(space);
    await appendUpsert();
    const onBuildingCheckpoint = vi.fn();
    const buildingReconciler = new VectorIndexReconciler({
      adapter,
      backendKey: "in-memory",
      clock: () => now,
      repository,
      spaces: {
        async findEmbeddingSpaceById(id) {
          return id === spaceId ? storedSpace : null;
        },
      },
      batchSize: 10,
      leaseMs: 1_000,
      maxAttempts: 3,
      retryDelayMs: 5_000,
      resolveCaughtUpReadiness: async () => "building",
      onCheckpointAdvanced: onBuildingCheckpoint,
    });

    await expect(buildingReconciler.runOnce()).resolves.toBe(true);
    expect(onBuildingCheckpoint).not.toHaveBeenCalled();

    await appendUpsert();
    const callbackError = new Error("activation callback failed");
    const failingCallback = vi.fn().mockRejectedValue(callbackError);
    const exactFallbackReconciler = new VectorIndexReconciler({
      adapter,
      backendKey: "in-memory",
      clock: () => now,
      repository,
      spaces: {
        async findEmbeddingSpaceById(id) {
          return id === spaceId ? storedSpace : null;
        },
      },
      batchSize: 10,
      leaseMs: 1_000,
      maxAttempts: 3,
      retryDelayMs: 5_000,
      resolveCaughtUpReadiness: async () => "exact_fallback",
      onCheckpointAdvanced: failingCallback,
    });

    await expect(exactFallbackReconciler.runOnce()).rejects.toBe(callbackError);
    expect(failingCallback).toHaveBeenCalledWith({
      workspaceId,
      embeddingSpaceId: spaceId,
      readiness: "exact_fallback",
    });
    await expect(repository.findCheckpoint({
      backendKey: "in-memory",
      workspaceId,
      embeddingSpaceId: spaceId,
    })).resolves.toMatchObject({
      readiness: "exact_fallback",
    });
  });

  it("drains a bounded number of non-empty batches", async () => {
    const adapter = new InMemoryVectorAdapter();
    const storedSpace = embeddingSpaceRecord(space);
    await appendUpsert();
    await appendUpsert();
    await appendUpsert();
    const reconciler = new VectorIndexReconciler({
      adapter,
      backendKey: "in-memory",
      clock: () => now,
      repository,
      spaces: {
        async findEmbeddingSpaceById(id) {
          return id === spaceId ? storedSpace : null;
        },
      },
      batchSize: 1,
      leaseMs: 1_000,
      maxAttempts: 3,
      retryDelayMs: 5_000,
      resolveCaughtUpReadiness: async () => "exact_fallback",
    });

    await expect(reconciler.runUntilIdle(2)).resolves.toBe(2);
    await expect(reconciler.runUntilIdle(100)).resolves.toBe(1);
    await expect(reconciler.runUntilIdle(1)).resolves.toBe(0);
    await expect(reconciler.runUntilIdle(0)).rejects.toThrow(
      /between 1 and 100/i,
    );
    await expect(reconciler.runUntilIdle(101)).rejects.toThrow(
      /between 1 and 100/i,
    );
    await expect(reconciler.runUntilIdle(1.5)).rejects.toThrow(
      /between 1 and 100/i,
    );
  });

  it("initializes an exact fallback checkpoint for a space with no projection work", async () => {
    await expect(repository.ensureCheckpoint({
      backendKey: "pgvector",
      workspaceId,
      embeddingSpaceId: spaceId,
      readiness: "exact_fallback",
    })).resolves.toMatchObject({
      acknowledgedSequence: "0",
      readiness: "exact_fallback",
    });

    await expect(repository.getLag({
      backendKey: "pgvector",
      workspaceId,
      embeddingSpaceId: spaceId,
    })).resolves.toMatchObject({
      requiredSequence: "0",
      acknowledgedSequence: "0",
      pendingCount: 0,
      readiness: "exact_fallback",
    });
  });

  it("publishes canonical embeddings and portable outbox work atomically", async () => {
    const documentId = randomUUID();
    const chunkId = randomUUID();
    await seedDocumentChunk({ database, workspaceId, documentId, chunkId });

    await database.withTransaction(async (client) => {
      await insertCanonicalChunkEmbeddingsForDocumentRevision(client, {
        workspaceId,
        documentId,
        documentRevision: 1,
        canonicalVersion: "1",
        embeddingSpace: space,
        chunks: [{
          id: chunkId,
          documentId,
          workspaceId,
          content: "portable projection",
          metadata: { state: "current" },
          embedding: [1, 0],
        }],
      });
    });

    const work = await database.query<{
      operation: string;
      canonical_version: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT operation, canonical_version, payload
       FROM vector_index_work
       WHERE workspace_id = $1 AND chunk_id = $2`,
      [workspaceId, chunkId],
    );
    expect(work).toMatchObject([{
      operation: "upsert",
      canonical_version: "1",
      payload: {
        dimensions: 2,
        distanceMetric: "cosine",
        vector: [1, 0],
        sourceId: null,
        metadata: { state: "current" },
        retrievalEnabled: true,
        retrievalExpiresAt: null,
      },
    }]);

    const rolledBackChunkId = randomUUID();
    await seedDocumentChunk({
      database,
      workspaceId,
      documentId,
      chunkId: rolledBackChunkId,
      chunkIndex: 1,
    });
    await expect(database.withTransaction(async (client) => {
      await insertCanonicalChunkEmbeddingsForDocumentRevision(client, {
        workspaceId,
        documentId,
        documentRevision: 1,
        canonicalVersion: "2",
        embeddingSpace: space,
        chunks: [{
          id: rolledBackChunkId,
          documentId,
          workspaceId,
          content: "rollback",
          metadata: {},
          embedding: [0, 1],
        }],
      });
      throw new Error("rollback projection");
    })).rejects.toThrow("rollback projection");
    await expect(database.query(
      "SELECT 1 FROM vector_index_work WHERE workspace_id = $1 AND chunk_id = $2",
      [workspaceId, rolledBackChunkId],
    )).resolves.toEqual([]);
  });

  it("allocates strictly monotonic filter versions within the canonical metadata transaction", async () => {
    const documentId = randomUUID();
    const chunkId = randomUUID();
    await seedDocumentChunk({ database, workspaceId, documentId, chunkId });
    await database.withTransaction((client) =>
      insertCanonicalChunkEmbeddingsForDocumentRevision(client, {
        workspaceId,
        documentId,
        documentRevision: 1,
        canonicalVersion: "1",
        embeddingSpace: space,
        chunks: [{
          id: chunkId,
          documentId,
          workspaceId,
          content: "filter versions",
          metadata: { state: "one" },
          embedding: [1, 0],
        }],
      }));

    for (const state of ["two", "three"]) {
      await database.kysely.transaction().execute(async (trx) => {
        await trx
          .updateTable("chunks")
          .set({ metadata: JSON.stringify({ state }) })
          .where("workspace_id", "=", workspaceId)
          .where("id", "=", chunkId)
          .executeTakeFirstOrThrow();
        await appendVectorFilterUpdatesForDocument(trx, {
          workspaceId,
          documentId,
        });
      });
    }

    const work = await database.query<{
      canonical_version: string;
      operation: string;
      payload: { metadata: { state: string } };
    }>(
      `SELECT canonical_version, operation, payload
       FROM vector_index_work
       WHERE workspace_id = $1 AND chunk_id = $2
       ORDER BY canonical_version`,
      [workspaceId, chunkId],
    );
    expect(work.map((row) => ({
      version: String(row.canonical_version),
      operation: row.operation,
      state: row.payload.metadata.state,
    }))).toEqual([
      { version: "1", operation: "upsert", state: "one" },
      { version: "2", operation: "filter_update", state: "two" },
      { version: "3", operation: "filter_update", state: "three" },
    ]);
  });

  it("keeps scoped rebuilds isolated and streams canonical records without an embedding provider", async () => {
    const adapter = new InMemoryVectorAdapter();
    const otherWorkspaceId = randomUUID();
    const records = [
      rebuildRecord(spaceId, workspaceId, "document-in-scope", "chunk-in-scope"),
      rebuildRecord(spaceId, workspaceId, "document-other", "chunk-other-document"),
      rebuildRecord(spaceId, otherWorkspaceId, "document-in-scope", "chunk-other-workspace"),
    ];
    const source: CanonicalVectorRebuildSourcePort = {
      async listTargets() {
        return [{ workspaceId, space }];
      },
      async scan(input) {
        const selected = records.filter((item) =>
          input.scope.kind === "document"
          && item.workspaceId === input.scope.workspaceId
          && item.record.documentId === input.scope.documentId);
        return { records: selected, nextCursor: null };
      },
    };
    const rebuild = new VectorIndexRebuildService({
      adapter,
      source,
      batchSize: 10,
    });

    await expect(rebuild.rebuild({
      scope: {
        kind: "document",
        workspaceId,
        documentId: "document-in-scope",
      },
      generation: "1",
    })).resolves.toMatchObject({
      recordsWritten: 1,
      spacesPrepared: 1,
    });
    await expect(adapter.search.search({
      workspaceId,
      space,
      queryVector: [1, 0],
      topK: 10,
      minimumScore: -1,
      filter: {},
    })).resolves.toMatchObject([{ chunkId: "chunk-in-scope" }]);
  });
});

const seedDocumentChunk = async (input: {
  database: Database;
  workspaceId: string;
  documentId: string;
  chunkId: string;
  chunkIndex?: number;
}): Promise<void> => {
  await input.database.query(
    `INSERT INTO documents (
       id, workspace_id, title, source_content, markdown_content, status, revision,
       metadata, retrieval_enabled
     )
     VALUES ($1, $2, 'Vector work', 'source', 'markdown', 'ready', 1, '{}'::jsonb, true)
     ON CONFLICT (id) DO NOTHING`,
    [input.documentId, input.workspaceId],
  );
  await input.database.query(
    `INSERT INTO chunks (
       id, document_id, workspace_id, chunk_index, content, search_text, metadata
     )
     VALUES ($1, $2, $3, $4, 'content', 'search', '{}'::jsonb)`,
    [
      input.chunkId,
      input.documentId,
      input.workspaceId,
      input.chunkIndex ?? 0,
    ],
  );
};

const embeddingSpaceRecord = (
  space: EmbeddingSpaceRef,
): EmbeddingSpaceRecord => ({
  id: space.id,
  identityFingerprint: `fingerprint-${space.id}`,
  provider: "openai",
  endpointScopeFingerprint: `scope-${space.id}`,
  model: "test-model",
  dimensions: space.dimensions,
  distanceMetric: space.distanceMetric,
  normalization: "provider_unit",
  documentTask: null,
  queryTask: null,
  vectorOptions: {},
  modelVersion: null,
  status: "active",
  quarantineReason: null,
  createdAt: now,
  updatedAt: now,
});

const rebuildRecord = (
  spaceId: string,
  workspaceId: string,
  documentId: string,
  chunkId: string,
): {
  workspaceId: string;
  space: EmbeddingSpaceRef;
  record: VectorIndexRecord;
} => ({
  workspaceId,
  space: {
    id: spaceId,
    dimensions: 2,
    distanceMetric: "cosine",
  },
  record: {
    chunkId,
    documentId,
    vector: [1, 0],
    version: "1",
    payload: {
      sourceId: null,
      metadata: {},
      retrievalEnabled: true,
      retrievalExpiresAt: null,
    },
  },
});
