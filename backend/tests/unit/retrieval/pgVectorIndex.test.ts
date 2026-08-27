import { describe, expect, it } from "vitest";

import type { VectorIndexSearchInput } from "../../../src/modules/retrieval/domain/vectorIndex.js";
import { PgVectorIndex } from "../../../src/modules/retrieval/infra/vectorSearch.js";
import type { Database } from "../../../src/shared/infra/database.js";

// The legacy `chunks.embedding` search leg, merged into canonical results by
// VectorCandidateSearchRolloutAdapter until issue #1101 retires it. It is the leg the
// parity gate measures canonical against, so its query shape is what that evidence
// means — these cases pin the shape rather than the class's continued existence.

interface Recorded {
  readonly statements: string[];
  readonly transactional: Array<{ sql: string; params: unknown[] }>;
  readonly direct: Array<{ sql: string; params: unknown[] }>;
}

const undefinedObject = (message: string): Error =>
  Object.assign(new Error(message), { code: "42704" });

/**
 * Stands in for the pg pool. `withoutIterativeScan` models a server whose pgvector
 * predates `hnsw.iterative_scan`, which pushes the same query onto the plain path.
 */
const databaseStub = (options: {
  rows?: Record<string, unknown>[];
  withoutIterativeScan?: boolean;
} = {}): { database: Database; recorded: Recorded } => {
  const recorded: Recorded = { statements: [], transactional: [], direct: [] };
  const rows = options.rows ?? [];
  const database = {
    async withTransaction(callback: (client: {
      query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
    }) => Promise<unknown>) {
      return callback({
        async query(sql: string, params?: unknown[]) {
          recorded.statements.push(sql);
          if (sql.startsWith("SET LOCAL")) {
            if (options.withoutIterativeScan) {
              throw undefinedObject('unrecognized configuration parameter "hnsw.iterative_scan"');
            }
            return { rows: [] };
          }
          recorded.transactional.push({ sql, params: params ?? [] });
          return { rows };
        },
      });
    },
    async query(sql: string, params: unknown[]) {
      recorded.direct.push({ sql, params });
      return rows;
    },
  } as unknown as Database;
  return { database, recorded };
};

const searchInput = (overrides: Partial<VectorIndexSearchInput> = {}): VectorIndexSearchInput => ({
  workspaceId: "workspace-1",
  queryEmbedding: [0.1, 0.2],
  queryEmbeddingDimensions: 2,
  topK: 2,
  similarityThreshold: 0.2,
  embeddingModel: "text-embedding-3-small",
  filter: {},
  ...overrides,
});

const onlyQuery = (recorded: Recorded): { sql: string; params: unknown[] } => {
  const issued = [...recorded.transactional, ...recorded.direct];
  expect(issued).toHaveLength(1);
  return issued[0];
};

describe("PgVectorIndex", () => {
  it("enables strict-order iterative scanning before the filtered query", async () => {
    const { database, recorded } = databaseStub();

    await new PgVectorIndex(database).search(searchInput());

    expect(recorded.statements[0]).toBe("SET LOCAL hnsw.iterative_scan = strict_order");
    expect(recorded.transactional).toHaveLength(1);
    expect(recorded.direct).toEqual([]);
  });

  it("returns ranked candidates without selecting chunk content", async () => {
    const { database, recorded } = databaseStub({
      rows: [{ chunk_id: "chunk-1", document_id: "doc-1", score: 0.91 }],
    });

    const results = await new PgVectorIndex(database).search(searchInput());

    const { sql, params } = onlyQuery(recorded);
    expect(params).toEqual(["workspace-1", "[0.1,0.2]", 2, 0.8, "text-embedding-3-small", 2]);
    expect(sql).toContain("1 - distance AS score");
    // Hydration belongs to the candidate hydrator; a content column here would make
    // every probe carry chunk text it never reads.
    expect(sql).not.toContain("content");
    expect(results).toEqual([{ chunkId: "chunk-1", documentId: "doc-1", score: 0.91 }]);
  });

  it("materializes the nearest-neighbour CTE and applies its scope inside it", async () => {
    const { database, recorded } = databaseStub();

    await new PgVectorIndex(database).search(searchInput());

    const { sql } = onlyQuery(recorded);
    expect(sql).toContain("WITH nearest_results AS MATERIALIZED");
    expect(sql).toContain("WHERE c.workspace_id = $1");
    expect(sql).toContain("AND c.embedding_model = $5");
    expect(sql).toContain("AND vector_dims(COALESCE(c.embedding_unbounded, c.embedding)) = $6");
    expect(sql).toContain("AND d.status = 'ready'");
    expect(sql).toContain("WHERE distance <= $4");
  });

  // A metadata predicate applied after the CTE would filter rows the ANN scan had
  // already spent its LIMIT on, so a filtered search would silently return short.
  it("keeps metadata filters inside the nearest-neighbour CTE", async () => {
    const { database, recorded } = databaseStub();

    await new PgVectorIndex(database).search(searchInput({
      filter: { metadataContains: { language: "en" } },
    }));

    const { sql, params } = onlyQuery(recorded);
    expect(params).toEqual([
      "workspace-1",
      "[0.1,0.2]",
      2,
      0.8,
      "text-embedding-3-small",
      2,
      JSON.stringify({ language: "en" }),
    ]);
    expect(sql.indexOf("c.metadata @> $7::jsonb"))
      .toBeLessThan(sql.indexOf("SELECT chunk_id"));
  });

  it("does not bind an unused source id array for manual-only scope", async () => {
    const { database, recorded } = databaseStub();

    await new PgVectorIndex(database).search(searchInput({
      filter: {
        source: { constrained: true, sourceIds: [], includeUnassignedDocuments: true },
      },
    }));

    const { sql, params } = onlyQuery(recorded);
    expect(sql).toContain("AND d.source_id IS NULL");
    expect(sql).not.toContain("$7");
    expect(params).toHaveLength(6);
  });

  // `chunks.embedding` is fixed at vector(1536) and is the column the HNSW index
  // covers, so a legacy-width probe has to name it rather than the unbounded column.
  it("uses the indexed 1536-dimensional column for legacy-width embeddings", async () => {
    const { database, recorded } = databaseStub();
    const queryEmbedding = new Array<number>(1536).fill(0);
    queryEmbedding[0] = 1;

    await new PgVectorIndex(database).search(searchInput({
      queryEmbedding,
      queryEmbeddingDimensions: 1536,
    }));

    const { sql, params } = onlyQuery(recorded);
    expect(params[5]).toBe(1536);
    expect(sql).toContain("c.embedding <=> $2::vector(1536)");
    expect(sql).toContain("AND vector_dims(c.embedding) = $6");
    expect(sql).not.toContain("embedding_unbounded");
  });

  it("falls back to the plain filtered query on a server without iterative scan", async () => {
    const { database, recorded } = databaseStub({ withoutIterativeScan: true });

    await new PgVectorIndex(database).search(searchInput());

    expect(recorded.transactional).toEqual([]);
    const { sql, params } = onlyQuery(recorded);
    expect(sql).toContain("WITH nearest_results AS MATERIALIZED");
    expect(params).toEqual(["workspace-1", "[0.1,0.2]", 2, 0.8, "text-embedding-3-small", 2]);
  });
});
