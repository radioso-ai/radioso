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
