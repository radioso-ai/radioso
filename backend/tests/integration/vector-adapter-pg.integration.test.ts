import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

import { PgVectorAdapter } from "../../src/modules/retrieval/infra/pgVectorAdapter.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } =
  await resolveIntegrationDatabase();

describeIntegration("PgVectorAdapter exact candidate search", () => {
  const database = new Database(integrationDatabaseUrl);
  const adapter = new PgVectorAdapter(database);
  const accountId = randomUUID();
  const workspaceIds: string[] = [];
  const embeddingSpaceIds: string[] = [];

  beforeAll(async () => {
    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash)
       VALUES ($1, $2, $3, $4)`,
      [
        accountId,
        "Pgvector Adapter Test",
        `pgvector-adapter-${accountId}@example.com`,
        "hash",
      ],
    );
  });

  afterEach(async () => {
    const ids = workspaceIds.splice(0);
    if (ids.length > 0) {
      await database.query(
        "DELETE FROM workspaces WHERE id = ANY($1::uuid[])",
        [ids],
      );
    }
    const spaceIds = embeddingSpaceIds.splice(0);
    if (spaceIds.length > 0) {
      await database.query(
        "DELETE FROM embedding_spaces WHERE id = ANY($1::uuid[])",
        [spaceIds],
      );
    }
  });

  afterAll(async () => {
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId])
      .catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  const createWorkspace = async (): Promise<string> => {
    const workspaceId = randomUUID();
    workspaceIds.push(workspaceId);
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key)
       VALUES ($1, $2, $3, $4)`,
      [
        workspaceId,
        accountId,
        `Vector workspace ${workspaceId}`,
        `vector-${workspaceId}`,
      ],
    );
    return workspaceId;
  };

  const createSpace = async (dimensions: number): Promise<{
    id: string;
    dimensions: number;
    distanceMetric: "cosine";
  }> => {
    const id = randomUUID();
    embeddingSpaceIds.push(id);
    await database.query(
      `INSERT INTO embedding_spaces (
         id,
         identity_fingerprint,
         provider,
         endpoint_scope_fingerprint,
         model,
         dimensions,
         distance_metric,
         normalization
       )
       VALUES ($1, $2, 'openai', $3, $4, $5, 'cosine', 'provider_unit')`,
      [
        id,
        `pgvector-space-${id}`,
        `pgvector-endpoint-${id}`,
        `pgvector-model-${dimensions}-${id}`,
        dimensions,
      ],
    );
    return { id, dimensions, distanceMetric: "cosine" };
  };

  const insertChunk = async (input: {
    workspaceId: string;
    chunkId?: string;
    title?: string;
    metadata?: Record<string, unknown>;
    status?: "processing" | "ready";
    retrievalEnabled?: boolean;
    revision?: number;
  }): Promise<{ chunkId: string; documentId: string }> => {
    const documentId = randomUUID();
    const chunkId = input.chunkId ?? randomUUID();
    const revision = input.revision ?? 1;
    await database.query(
      `INSERT INTO documents (
         id,
         workspace_id,
         title,
         source_content,
         markdown_content,
         status,
         revision,
         metadata,
         retrieval_enabled
       )
       VALUES ($1, $2, $3, 'source', 'markdown', $4, $5, '{}'::jsonb, $6)`,
      [
        documentId,
        input.workspaceId,
        input.title ?? `Document ${documentId}`,
        input.status ?? "ready",
        revision,
        input.retrievalEnabled ?? true,
      ],
    );
    await database.query(
      `INSERT INTO chunks (
         id,
         document_id,
         workspace_id,
         chunk_index,
         content,
         search_text,
         metadata
       )
       VALUES ($1, $2, $3, 0, 'content', 'search text', $4::jsonb)`,
      [
        chunkId,
        documentId,
        input.workspaceId,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    return { chunkId, documentId };
  };

  const insertEmbedding = async (input: {
    workspaceId: string;
    chunkId: string;
    spaceId: string;
    dimensions: number;
    vector: number[];
    documentRevision?: number;
    canonicalVersion?: string;
  }): Promise<void> => {
    await database.query(
      `INSERT INTO chunk_embeddings (
         workspace_id,
         chunk_id,
         embedding_space_id,
         document_revision,
         canonical_version,
         dimensions,
         embedding,
         content_hash
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7::vector, $8)`,
      [
        input.workspaceId,
        input.chunkId,
        input.spaceId,
        input.documentRevision ?? 1,
        input.canonicalVersion ?? "1",
        input.dimensions,
        vectorLiteral(input.vector),
        `hash-${input.chunkId}-${input.spaceId}`,
      ],
    );
  };

  it("declares both search modes, since the width decides which one answers", async () => {
    await expect(adapter.capabilities.getCapabilities()).resolves.toEqual({
      backend: "pgvector",
      dimensionRanges: [{ min: 1, max: 16_000 }],
      distanceMetrics: ["cosine"],
      filterOperations: [
        "source",
        "metadata_containment",
        "retrieval_eligibility",
        "expiry",
      ],
      maxBatchSize: 1_000,
      // Widths within pgvector's HNSW ceiling are answered approximately from a
      // partial index; wider ones, and any width before its index exists, fall back
      // to an exact scan of the same query.
      searchModes: ["exact", "accelerated"],
      consistency: "transactional",
    });
  });

  it.each([768, 3_072])(
    "searches canonical %i-dimensional vectors without fixed typmods",
    async (dimensions) => {
      const workspaceId = await createWorkspace();
      const space = await createSpace(dimensions);
      const { chunkId, documentId } = await insertChunk({ workspaceId });
      const vector = unitVector(dimensions, 0);
      await insertEmbedding({
        workspaceId,
        chunkId,
        spaceId: space.id,
        dimensions,
        vector,
        canonicalVersion: "9007199254740993",
      });

      const candidates = await adapter.search.search({
        workspaceId,
        space,
        queryVector: vector,
        topK: 5,
        minimumScore: 1,
        filter: {},
      });

      expect(candidates).toEqual([{
        chunkId,
        documentId,
        embeddingSpaceId: space.id,
        version: "9007199254740993",
        score: 1,
      }]);
    },
  );

  it("isolates workspace and active space before comparing incompatible dimensions", async () => {
    const workspaceId = await createWorkspace();
    const otherWorkspaceId = await createWorkspace();
    const activeSpace = await createSpace(768);
    const pendingSpace = await createSpace(3_072);
    await database.query(
      `INSERT INTO workspace_embedding_profiles (
         workspace_id,
         active_embedding_space_id,
         pending_embedding_space_id
       )
       VALUES ($1, $2, $3)`,
      [workspaceId, activeSpace.id, pendingSpace.id],
    );

    const active = await insertChunk({
      workspaceId,
      chunkId: "00000000-0000-4000-8000-000000000001",
    });
    const pending = await insertChunk({
      workspaceId,
      chunkId: "00000000-0000-4000-8000-000000000002",
    });
    const otherWorkspace = await insertChunk({
      workspaceId: otherWorkspaceId,
      chunkId: "00000000-0000-4000-8000-000000000003",
    });
    await insertEmbedding({
      workspaceId,
      chunkId: active.chunkId,
      spaceId: activeSpace.id,
      dimensions: 768,
      vector: unitVector(768, 0),
    });
    await insertEmbedding({
      workspaceId,
      chunkId: pending.chunkId,
      spaceId: pendingSpace.id,
      dimensions: 3_072,
      vector: unitVector(3_072, 0),
    });
    await insertEmbedding({
      workspaceId: otherWorkspaceId,
      chunkId: otherWorkspace.chunkId,
      spaceId: activeSpace.id,
      dimensions: 768,
      vector: unitVector(768, 0),
    });

    const candidates = await adapter.search.search({
      workspaceId,
      space: activeSpace,
      queryVector: unitVector(768, 0),
      topK: 10,
      minimumScore: -1,
      filter: {},
    });

    expect(candidates.map(({ chunkId }) => chunkId)).toEqual([active.chunkId]);
  });

  it("normalizes cosine scores, includes the threshold, and breaks ties by chunk id", async () => {
    const workspaceId = await createWorkspace();
    const space = await createSpace(2);
    const chunkA = await insertChunk({
      workspaceId,
      chunkId: "00000000-0000-4000-8000-000000000001",
    });
    const chunkB = await insertChunk({
      workspaceId,
      chunkId: "00000000-0000-4000-8000-000000000002",
    });
    const threshold = await insertChunk({
      workspaceId,
      chunkId: "00000000-0000-4000-8000-000000000003",
    });
    const below = await insertChunk({
      workspaceId,
      chunkId: "00000000-0000-4000-8000-000000000004",
    });
    for (const chunk of [chunkB, chunkA]) {
      await insertEmbedding({
        workspaceId,
        chunkId: chunk.chunkId,
        spaceId: space.id,
        dimensions: 2,
        vector: [1, 0],
      });
    }
    await insertEmbedding({
      workspaceId,
      chunkId: threshold.chunkId,
      spaceId: space.id,
      dimensions: 2,
      vector: [0, 1],
    });
    await insertEmbedding({
      workspaceId,
      chunkId: below.chunkId,
      spaceId: space.id,
      dimensions: 2,
      vector: [-1, 0],
    });

    const candidates = await adapter.search.search({
      workspaceId,
      space,
      queryVector: [1, 0],
      topK: 10,
      minimumScore: 0,
      filter: {},
    });

    expect(candidates.map(({ chunkId, score }) => ({ chunkId, score }))).toEqual([
      { chunkId: chunkA.chunkId, score: 1 },
      { chunkId: chunkB.chunkId, score: 1 },
      { chunkId: threshold.chunkId, score: 0 },
    ]);
  });

  it("filters canonical metadata and excludes ineligible or stale document revisions before topK", async () => {
    const workspaceId = await createWorkspace();
    const space = await createSpace(2);
    const eligible = await insertChunk({
      workspaceId,
      chunkId: "00000000-0000-4000-8000-000000000004",
      metadata: { customer: { id: "acme", tags: ["priority", "support"] } },
    });
    const wrongMetadata = await insertChunk({
      workspaceId,
      chunkId: "00000000-0000-4000-8000-000000000001",
      metadata: { customer: { id: "other" } },
    });
    const disabled = await insertChunk({
      workspaceId,
      chunkId: "00000000-0000-4000-8000-000000000002",
      metadata: { customer: { id: "acme", tags: ["priority"] } },
      retrievalEnabled: false,
    });
    const stale = await insertChunk({
      workspaceId,
      chunkId: "00000000-0000-4000-8000-000000000003",
      metadata: { customer: { id: "acme", tags: ["priority"] } },
      revision: 2,
    });
    for (const chunk of [eligible, wrongMetadata, disabled]) {
      await insertEmbedding({
        workspaceId,
        chunkId: chunk.chunkId,
        spaceId: space.id,
        dimensions: 2,
        vector: [1, 0],
      });
    }
    await insertEmbedding({
      workspaceId,
      chunkId: stale.chunkId,
      spaceId: space.id,
      dimensions: 2,
      vector: [1, 0],
      documentRevision: 1,
    });

    const candidates = await adapter.search.search({
      workspaceId,
      space,
      queryVector: [1, 0],
      topK: 1,
      minimumScore: 1,
      filter: {
        metadataContains: {
          customer: {
            id: "acme",
            tags: ["priority"],
          },
        },
        retrievalEnabled: true,
      },
    });

    expect(candidates).toEqual([expect.objectContaining({
      chunkId: eligible.chunkId,
      documentId: eligible.documentId,
    })]);
  });

  it("rejects incompatible query dimensions and invalid search controls before querying", async () => {
    const space = {
      id: randomUUID(),
      dimensions: 3,
      distanceMetric: "cosine" as const,
    };
    const base = {
      workspaceId: randomUUID(),
      space,
      queryVector: [1, 0, 0],
      topK: 10,
      minimumScore: -1,
      filter: {},
    };

    await expect(adapter.search.search({
      ...base,
      queryVector: [1, 0],
    })).rejects.toThrow("vector_dimension_mismatch");
    await expect(adapter.search.search({
      ...base,
      topK: 0,
    })).rejects.toThrow("invalid_vector_top_k");
    await expect(adapter.search.search({
      ...base,
      minimumScore: 1.01,
    })).rejects.toThrow("invalid_vector_minimum_score");
  });
});

const unitVector = (dimensions: number, index: number): number[] =>
  Array.from({ length: dimensions }, (_, current) => current === index ? 1 : 0);

const vectorLiteral = (vector: readonly number[]): string =>
  `[${vector.join(",")}]`;
