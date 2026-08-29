import { describe, expect, it } from "vitest";

import { PgVectorAdapter } from "../../../src/modules/retrieval/infra/pgVectorAdapter.js";
import type { Database } from "../../../src/shared/infra/database.js";

describe("PgVectorAdapter", () => {
  it("uses high-recall strict iterative HNSW scanning for a filtered candidate query", async () => {
    const calls: string[] = [];
    const database = {
      withTransaction: async (callback: (client: {
        query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
      }) => Promise<unknown>) => callback({
        query: async <T>(sql: string) => {
          calls.push(sql);
          return {
            rows: sql.startsWith("WITH nearest")
              ? [{
                chunk_id: "chunk-1",
                document_id: "document-1",
                embedding_space_id: "space-1",
                canonical_version: "1",
                score: 0.9,
              } as T]
              : [],
          };
        },
      }),
      query: async <T>() => [] as T[],
    } as unknown as Database;

    const adapter = new PgVectorAdapter(database);
    const results = await adapter.search.search({
      workspaceId: "workspace-1",
      space: { id: "space-1", dimensions: 2, distanceMetric: "cosine" },
      queryVector: [1, 0],
      topK: 5,
      minimumScore: 0,
      filter: { retrievalEnabled: true },
    });

    expect(calls[0]).toBe("SET LOCAL hnsw.ef_search = 1000");
    expect(calls[1]).toBe("SET LOCAL hnsw.max_scan_tuples = 20000");
    expect(calls[2]).toBe("SET LOCAL hnsw.iterative_scan = strict_order");
    expect(calls[3]).toContain("WITH nearest");
    expect(results).toEqual([{
      chunkId: "chunk-1",
      documentId: "document-1",
      embeddingSpaceId: "space-1",
      version: "1",
      score: 0.9,
    }]);
  });

  it("falls back for pgvector versions that do not support iterative scanning", async () => {
    const directQueries: string[] = [];
    const database = {
      withTransaction: async (callback: (client: {
        query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
      }) => Promise<unknown>) => callback({
        query: async () => {
          // undefined_object: the SQLSTATE Postgres reports for an unknown GUC.
          throw Object.assign(
            new Error('unrecognized configuration parameter "hnsw.iterative_scan"'),
            { code: "42704" },
          );
        },
      }),
      query: async <T>(sql: string) => {
        directQueries.push(sql);
        return [] as T[];
      },
    } as unknown as Database;

    const adapter = new PgVectorAdapter(database);
    await expect(adapter.search.search({
      workspaceId: "workspace-1",
      space: { id: "space-1", dimensions: 2, distanceMetric: "cosine" },
      queryVector: [1, 0],
      topK: 5,
      minimumScore: 0,
      filter: {},
    })).resolves.toEqual([]);

    expect(directQueries).toHaveLength(1);
  });
});
