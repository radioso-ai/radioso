import { describe, expect, it } from "vitest";

import { ChunkRepository } from "../../src/db/repositories/chunkRepository.js";

describe("chunk repository", () => {
  it("deletes by document and workspace when replacing chunks", async () => {
    const calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
    const repository = new ChunkRepository({
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
    const repository = new ChunkRepository({
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
    const repository = new ChunkRepository({
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
    const repository = new ChunkRepository({
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
    const repository = new ChunkRepository({
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
    const repository = new ChunkRepository({
      async query() {
        throw new Error("unused");
      },
      async withTransaction(callback: (client: { query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> }) => Promise<unknown>) {
        const client = {
          async query(sql: string, params?: unknown[]) {
            calls.push({ sql, params });

            if (sql.includes("FOR UPDATE")) {
              return { rows: [{ id: "doc-1" }] };
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
      chunks: [],
    });

    expect(calls.some((call) => call.sql === "DELETE FROM chunks WHERE document_id = $1 AND workspace_id = $2")).toBe(true);
    expect(calls).toContainEqual({
      sql: "DELETE FROM chunks WHERE document_id = $1 AND workspace_id = $2",
      params: ["doc-1", "workspace-1"],
    });
  });
});
