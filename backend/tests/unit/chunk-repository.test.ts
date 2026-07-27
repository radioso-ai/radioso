import { describe, expect, it } from "vitest";

import { ChunkRepository } from "../../src/modules/documents/infra/chunkRepository.js";
import {
  PgVectorChunkStorage,
  type ChunkVectorStoragePort,
} from "../../src/modules/retrieval/infra/chunkVectorStorage.js";

const noopVectorStorage: ChunkVectorStoragePort = {
  async insertChunks() {
    return;
  },
};

const createRepository = (database: ConstructorParameters<typeof ChunkRepository>[0], vectorStorage = noopVectorStorage) =>
  new ChunkRepository(database, vectorStorage);

const chunkInsertRows = (params: unknown[] | undefined) => {
  expect(params).toBeDefined();
  const values = params!;
  const columnsPerChunk = 12;
  return Array.from({ length: values.length / columnsPerChunk }, (_, index) => {
    const offset = index * columnsPerChunk;
    return {
      id: values[offset],
      documentId: values[offset + 1],
      workspaceId: values[offset + 2],
      chunkIndex: values[offset + 3],
      content: values[offset + 4],
      searchText: values[offset + 5],
      boundedEmbedding: values[offset + 6],
      unboundedEmbedding: values[offset + 7],
      embeddingModel: values[offset + 8],
      startOffset: values[offset + 9],
      endOffset: values[offset + 10],
      metadata: values[offset + 11],
    };
  });
};

describe("chunk repository", () => {
  it("delegates chunk inserts to vector storage when replacing chunks", async () => {
    const insertedChunks: unknown[] = [];
    const repository = createRepository(
      {
        async query() {
          throw new Error("unused");
        },
        async withTransaction(callback: (client: { query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> }) => Promise<unknown>) {
          const client = {
            async query() {
              return { rows: [] };
            },
          };

          return callback(client as never);
        },
      } as never,
      {
        async insertChunks(_client, chunks) {
          insertedChunks.push(...chunks);
        },
      },
    );

    const chunk = {
      id: "chunk-1",
      documentId: "doc-1",
      workspaceId: "workspace-1",
      chunkIndex: 0,
      content: "content",
      searchText: "content",
      embedding: [0.1, 0.2],
      startOffset: 0,
      endOffset: 7,
      metadata: {},
      createdAt: new Date(),
    };

    await repository.replaceForDocument("doc-1", [chunk]);

    expect(insertedChunks).toEqual([chunk]);
  });

  it("serializes pgvector chunk inserts without exposing vector columns to the repository", async () => {
    const calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
    const storage = new PgVectorChunkStorage();

    await storage.insertChunks({
      async query(sql: string, params?: unknown[]) {
        calls.push({ sql, params });
        return { rows: [] };
      },
    }, [
      {
        id: "chunk-1536",
        documentId: "doc-1",
        workspaceId: "workspace-1",
        chunkIndex: 0,
        content: "bounded",
        searchText: null,
        embedding: new Array(1536).fill(0.1),
        embeddingModel: null,
        startOffset: 0,
        endOffset: 7,
        metadata: { kind: "bounded" },
        createdAt: new Date(),
      },
      {
        id: "chunk-custom",
        documentId: "doc-1",
        workspaceId: "workspace-1",
        chunkIndex: 1,
        content: "unbounded",
        searchText: "custom search",
        embedding: [0.2, 0.3],
        embeddingModel: "custom-model",
        startOffset: 8,
        endOffset: 17,
        metadata: { kind: "custom" },
        createdAt: new Date(),
      },
    ]);

    expect(calls[0]?.sql).toContain("embedding_unbounded");
    expect(calls[0]?.sql).toContain("::vector");
    expect(chunkInsertRows(calls[0]?.params)).toMatchObject([
      {
        id: "chunk-1536",
        boundedEmbedding: `[${new Array(1536).fill(0.1).join(",")}]`,
        unboundedEmbedding: null,
        embeddingModel: "text-embedding-3-small",
      },
      {
        id: "chunk-custom",
        boundedEmbedding: null,
        unboundedEmbedding: "[0.2,0.3]",
        embeddingModel: "custom-model",
      },
    ]);
  });

  it("deletes by document and workspace when replacing chunks", async () => {
    const calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
    const repository = createRepository({
      async query() {
        throw new Error("unused");
      },
      async withTransaction(callback: (client: { query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> }) => Promise<unknown>) {
        const client = {
          async query(sql: string, params?: unknown[]) {
            calls.push({ sql, params });
            return { rows: [] };
          },
        };

        return callback(client as never);
      },
    } as never);

    await repository.replaceForDocument("doc-1", [
      {
        id: "chunk-1",
        documentId: "doc-1",
        workspaceId: "workspace-1",
        chunkIndex: 0,
        content: "content",
        searchText: "content",
        embedding: [0.1, 0.2],
        startOffset: 0,
        endOffset: 7,
        metadata: {},
        createdAt: new Date(),
      },
    ]);

    expect(calls[0]).toEqual({
      sql: "DELETE FROM chunks WHERE document_id = $1 AND workspace_id = $2",
      params: ["doc-1", "workspace-1"],
    });
  });

  it("looks up workspace id before deleting when replacing a document with no chunks", async () => {
    const calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
    const repository = createRepository({
      async query() {
        throw new Error("unused");
      },
      async withTransaction(callback: (client: { query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> }) => Promise<unknown>) {
        const client = {
          async query(sql: string, params?: unknown[]) {
            calls.push({ sql, params });

            if (sql.includes("SELECT workspace_id")) {
              return { rows: [{ workspace_id: "workspace-1" }] };
            }

            return { rows: [] };
          },
        };

        return callback(client as never);
      },
    } as never);

    await repository.replaceForDocument("doc-1", []);

    expect(calls[0]).toEqual({
      sql: `SELECT workspace_id
     FROM documents
     WHERE id = $1`,
      params: ["doc-1"],
    });
    expect(calls[1]).toEqual({
      sql: "DELETE FROM chunks WHERE document_id = $1 AND workspace_id = $2",
      params: ["doc-1", "workspace-1"],
    });
  });

  it("lists chunk summaries ordered by chunk_index", async () => {
    const calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
    const repository = createRepository({
      async query(sql: string, params?: unknown[]) {
        calls.push({ sql, params });
        return [
          {
            id: "chunk-a",
            chunk_index: 0,
            content: "first chunk content",
            start_offset: 0,
            end_offset: 19,
            content_length: 19,
          },
          {
            id: "chunk-b",
            chunk_index: 1,
            content: "second chunk content",
            start_offset: 19,
            end_offset: 39,
            content_length: 20,
          },
        ];
      },
      async withTransaction() {
        throw new Error("unused");
      },
    } as never);

    const summaries = await repository.listSummariesForDocument({
      documentId: "doc-1",
      workspaceId: "workspace-1",
    });

    expect(calls[0]?.params?.slice(0, 2)).toEqual(["doc-1", "workspace-1"]);
    expect(calls[0]?.sql).toContain("FROM chunks");
    expect(calls[0]?.sql).toContain("ORDER BY chunk_index");
    expect(summaries).toEqual([
      {
        id: "chunk-a",
        chunkIndex: 0,
        contentPreview: "first chunk content",
        contentLength: 19,
        startOffset: 0,
        endOffset: 19,
      },
      {
        id: "chunk-b",
        chunkIndex: 1,
        contentPreview: "second chunk content",
        contentLength: 20,
        startOffset: 19,
        endOffset: 39,
      },
    ]);
  });

  it("returns null when fetching a missing chunk", async () => {
    const repository = createRepository({
      async query() {
        return [];
      },
      async withTransaction() {
        throw new Error("unused");
      },
    } as never);

    const chunk = await repository.findByIdForDocument({
      chunkId: "chunk-missing",
      documentId: "doc-1",
      workspaceId: "workspace-1",
    });

    expect(chunk).toBeNull();
  });

  it("fetches a chunk by id scoped to document and workspace", async () => {
    const calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
    const createdAt = new Date("2025-01-02T03:04:05.000Z");
    const repository = createRepository({
      async query(sql: string, params?: unknown[]) {
        calls.push({ sql, params });
        return [
          {
            id: "chunk-1",
            document_id: "doc-1",
            workspace_id: "workspace-1",
            chunk_index: 3,
            content: "chunk body",
            search_text: "chunk body search",
            start_offset: 100,
            end_offset: 110,
            metadata: { source: "page-2" },
            created_at: createdAt,
            embedding_dimensions: 1536,
          },
        ];
      },
      async withTransaction() {
        throw new Error("unused");
      },
    } as never);

    const chunk = await repository.findByIdForDocument({
      chunkId: "chunk-1",
      documentId: "doc-1",
      workspaceId: "workspace-1",
    });

    expect(calls[0]?.params).toEqual(["chunk-1", "doc-1", "workspace-1"]);
    expect(chunk).toEqual({
      id: "chunk-1",
      documentId: "doc-1",
      workspaceId: "workspace-1",
      chunkIndex: 3,
      content: "chunk body",
      searchText: "chunk body search",
      startOffset: 100,
      endOffset: 110,
      metadata: { source: "page-2" },
      createdAt,
      embeddingDimensions: 1536,
    });
  });

  it("deletes by document and workspace when publishing a document revision", async () => {
    const calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
    const repository = createRepository({
      async query() {
        throw new Error("unused");
      },
      async withTransaction(callback: (client: { query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> }) => Promise<unknown>) {
        const client = {
          async query(sql: string, params?: unknown[]) {
            calls.push({ sql, params });

            if (sql.includes("FROM workspace_embedding_transitions retired")) {
              return { rows: [] };
            }
            if (sql.includes("FROM workspace_embedding_profiles")) {
              return {
                rows: [{ active_embedding_space_id: "space-1" }],
              };
            }
            if (sql.includes("FOR UPDATE")) {
              return { rows: [{ id: "doc-1" }] };
            }
            if (sql.includes("FROM embedding_spaces")) {
              return {
                rows: [{
                  id: "space-1",
                  dimensions: 1536,
                  distance_metric: "cosine",
                }],
              };
            }

            return { rows: [] };
          },
        };

        return callback(client as never);
      },
    } as never);

    await repository.publishForDocumentRevision({
      documentId: "doc-1",
      workspaceId: "workspace-1",
      revision: 2,
      embeddingSpace: {
        id: "space-1",
        dimensions: 1536,
        distanceMetric: "cosine",
      },
      canonicalVersion: "2",
      chunks: [],
    });

    expect(calls.some((call) => call.sql === "DELETE FROM chunks WHERE document_id = $1 AND workspace_id = $2")).toBe(true);
    expect(calls).toContainEqual({
      sql: "DELETE FROM chunks WHERE document_id = $1 AND workspace_id = $2",
      params: ["doc-1", "workspace-1"],
    });
  });

  it("publishes canonical vectors with immutable space identity in the document transaction", async () => {
    const calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
    const repository = createRepository(
      {
        async query() {
          throw new Error("unused");
        },
        async withTransaction(
          callback: (client: {
            query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
          }) => Promise<unknown>,
        ) {
          const client = {
            async query(sql: string, params?: unknown[]) {
              calls.push({ sql, params });

              if (sql.includes("FROM documents")) {
                return { rows: [{ id: "doc-1" }] };
              }
              if (sql.includes("FROM embedding_spaces")) {
                return {
                  rows: [
                    {
                      id: "space-768",
                      dimensions: 3,
                      distance_metric: "cosine",
                    },
                  ],
                };
              }

              return { rows: [] };
            },
          };

          return callback(client as never);
        },
      } as never,
      {
        async insertChunks() {
          return;
        },
      },
    );

    await repository.publishForDocumentRevision({
      documentId: "doc-1",
      workspaceId: "workspace-1",
      revision: 2,
      embeddingSpace: {
        id: "space-768",
        dimensions: 3,
        distanceMetric: "cosine",
      },
      canonicalVersion: "2",
      chunks: [
        {
          id: "chunk-1",
          documentId: "doc-1",
          workspaceId: "workspace-1",
          chunkIndex: 0,
          content: "content",
          searchText: "search content",
          embedding: [0.123456789, -0.25, 0.375],
          startOffset: 0,
          endOffset: 7,
          metadata: {},
          createdAt: new Date(),
        },
      ],
    });

    const canonicalInsert = calls.find((call) => call.sql.includes("INSERT INTO chunk_embeddings"));
    const readyUpdateIndex = calls.findIndex((call) => call.sql.includes("SET status = 'ready'"));
    const canonicalInsertIndex = calls.findIndex((call) =>
      call.sql.includes("INSERT INTO chunk_embeddings"),
    );

    expect(canonicalInsertIndex).toBeGreaterThan(-1);
    expect(canonicalInsertIndex).toBeLessThan(readyUpdateIndex);
    expect(canonicalInsert?.params).toEqual([
      "workspace-1",
      "chunk-1",
      "space-768",
      2,
      "2",
      3,
      "[0.123456789,-0.25,0.375]",
      expect.any(String),
    ]);
  });

  it("keeps incompatible legacy dimensions out of the fixed vector column during canonical publication", async () => {
    const calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
    const embedding = Array.from({ length: 3072 }, (_, index) => index / 3072);
    const repository = createRepository(
      {
        async query() {
          throw new Error("unused");
        },
        async withTransaction(
          callback: (client: {
            query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
          }) => Promise<unknown>,
        ) {
          const client = {
            async query(sql: string, params?: unknown[]) {
              calls.push({ sql, params });

              if (sql.includes("FROM documents")) {
                return { rows: [{ id: "doc-1" }] };
              }
              if (sql.includes("FROM embedding_spaces")) {
                return {
                  rows: [
                    {
                      id: "space-3072",
                      dimensions: 3072,
                      distance_metric: "cosine",
                    },
                  ],
                };
              }

              return { rows: [] };
            },
          };

          return callback(client as never);
        },
      } as never,
      new PgVectorChunkStorage(),
    );

    await repository.publishForDocumentRevision({
      documentId: "doc-1",
      workspaceId: "workspace-1",
      revision: 2,
      embeddingSpace: {
        id: "space-3072",
        dimensions: 3072,
        distanceMetric: "cosine",
      },
      canonicalVersion: "2",
      chunks: [
        {
          id: "chunk-3072",
          documentId: "doc-1",
          workspaceId: "workspace-1",
          chunkIndex: 0,
          content: "content",
          embedding,
          embeddingModel: "text-embedding-3-large",
          startOffset: 0,
          endOffset: 7,
          metadata: {},
          createdAt: new Date(),
        },
      ],
    });

    const legacyInsert = calls.find((call) => call.sql.includes("INSERT INTO chunks"));
    const legacyRows = chunkInsertRows(legacyInsert?.params);
    expect(legacyRows[0]).toMatchObject({
      boundedEmbedding: null,
      unboundedEmbedding: `[${embedding.join(",")}]`,
    });
    expect(calls.some((call) => call.sql.includes("INSERT INTO chunk_embeddings"))).toBe(true);
  });
});
