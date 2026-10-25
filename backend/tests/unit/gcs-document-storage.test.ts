import type { Storage } from "@google-cloud/storage";
import { describe, expect, it, vi } from "vitest";

import { GcsDocumentStorage } from "../../src/modules/documents/infra/gcsDocumentStorage.js";

/** Stands in for the Cloud Storage client: one bucket's listing and its files' deletes. */
const createClient = () => {
  const getFiles = vi.fn();
  const remove = vi.fn(async (_options?: unknown) => [{}]);
  const save = vi.fn(async (_buffer: Buffer, _options?: unknown) => undefined);
  const files: Array<{ bucket: string; name: string }> = [];
  const client = {
    bucket: (bucket: string) => ({
      getFiles,
      file: (name: string) => {
        files.push({ bucket, name });
        return { delete: remove, save, getMetadata: async () => [{ generation: "7", size: "3" }] };
      },
    }),
  };
  return { storage: client as unknown as Storage, getFiles, remove, save, files };
};

describe("GcsDocumentStorage", () => {
  it("lists a bounded page of one workspace's objects, nested paths included, in its own bucket", async () => {
    const client = createClient();
    client.getFiles.mockResolvedValue([
      [{ name: "workspaces/workspace-1/documents/a" }, { name: "workspaces/workspace-1/documents/b/1716000000000-report.pdf" }],
      null,
      {},
    ]);
    const storage = new GcsDocumentStorage("radioso-documents", { storage: client.storage });

    expect(await storage.listWorkspaceObjects({ workspaceId: "workspace-1", limit: 50 })).toEqual([
      { bucket: "radioso-documents", objectPath: "workspaces/workspace-1/documents/a", generation: null },
      { bucket: "radioso-documents", objectPath: "workspaces/workspace-1/documents/b/1716000000000-report.pdf", generation: null },
    ]);
    expect(client.getFiles).toHaveBeenCalledWith({ prefix: "workspaces/workspace-1/", autoPaginate: false, maxResults: 50 });
  });

  it("lists the workspaces it holds objects for by prefix, one page per call", async () => {
    const client = createClient();
    client.getFiles
      .mockResolvedValueOnce([[], { pageToken: "page-2" }, { prefixes: ["workspaces/workspace-a/", "workspaces/workspace-b/"] }])
      .mockResolvedValueOnce([[], null, { prefixes: ["workspaces/workspace-c/"] }])
      .mockResolvedValueOnce([[], null, {}]);
    const storage = new GcsDocumentStorage("radioso-documents", { storage: client.storage });

    expect(await storage.listStoredWorkspaces({ cursor: null, limit: 2 }))
      .toEqual({ workspaceIds: ["workspace-a", "workspace-b"], nextCursor: "page-2" });
    expect(await storage.listStoredWorkspaces({ cursor: "page-2", limit: 2 }))
      .toEqual({ workspaceIds: ["workspace-c"], nextCursor: null });
    expect(await storage.listStoredWorkspaces({ cursor: null, limit: 2 })).toEqual({ workspaceIds: [], nextCursor: null });
    expect(client.getFiles.mock.calls.map(([query]) => query)).toEqual([
      { prefix: "workspaces/", delimiter: "/", autoPaginate: false, maxResults: 2 },
      { prefix: "workspaces/", delimiter: "/", autoPaginate: false, maxResults: 2, pageToken: "page-2" },
      { prefix: "workspaces/", delimiter: "/", autoPaginate: false, maxResults: 2 },
    ]);
  });

  it("treats deleting an object that is already gone as done", async () => {
    const client = createClient();
    const storage = new GcsDocumentStorage("radioso-documents", { storage: client.storage });

    await storage.delete({ bucket: "radioso-documents", objectPath: "workspaces/workspace-1/documents/a", generation: null });

    expect(client.remove).toHaveBeenCalledWith({ ignoreNotFound: true });
  });

  it("refuses a workspace id that is not a single path segment", async () => {
    const client = createClient();
    const storage = new GcsDocumentStorage("radioso-documents", { storage: client.storage });

    for (const workspaceId of ["", "..", "workspace-1/documents"]) {
      await expect(storage.listWorkspaceObjects({ workspaceId, limit: 10 })).rejects.toThrow();
    }
    expect(client.getFiles).not.toHaveBeenCalled();
  });

  it("summarizes a workspace's objects across listing pages, by their newest write", async () => {
    const client = createClient();
    client.getFiles
      .mockResolvedValueOnce([
        [
          { name: "workspaces/workspace-1/documents/a", metadata: { timeCreated: "2026-01-01T00:00:00Z", updated: "2026-01-02T00:00:00Z" } },
          { name: "workspaces/workspace-1/documents/b", metadata: { timeCreated: "2026-02-01T00:00:00Z" } },
        ],
        { pageToken: "page-2" },
        {},
      ])
      .mockResolvedValueOnce([
        [{ name: "workspaces/workspace-1/documents/c", metadata: { updated: "2026-01-15T00:00:00Z" } }],
        null,
        {},
      ]);
    const storage = new GcsDocumentStorage("radioso-documents", { storage: client.storage });

    expect(await storage.summarizeWorkspaceObjects({ workspaceId: "workspace-1" }))
      .toEqual({ objectCount: 3, newestObjectAt: new Date("2026-02-01T00:00:00Z") });
    expect(client.getFiles.mock.calls.map(([query]) => query)).toEqual([
      { prefix: "workspaces/workspace-1/", autoPaginate: false, maxResults: 1_000 },
      { prefix: "workspaces/workspace-1/", autoPaginate: false, maxResults: 1_000, pageToken: "page-2" },
    ]);
  });

  it("reads an object with no recorded write time as written just now, so it never looks old", async () => {
    const client = createClient();
    client.getFiles.mockResolvedValueOnce([[{ name: "workspaces/workspace-1/documents/a", metadata: {} }], null, {}]);
    const storage = new GcsDocumentStorage("radioso-documents", { storage: client.storage });
    const before = Date.now();

    const summary = await storage.summarizeWorkspaceObjects({ workspaceId: "workspace-1" });

    expect(summary.objectCount).toBe(1);
    expect(summary.newestObjectAt!.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("writes every upload under its workspace's prefix, and refuses a workspace id that would leave it", async () => {
    const client = createClient();
    const storage = new GcsDocumentStorage("radioso-documents", { storage: client.storage });
    const upload = (workspaceId: string) => storage.upload({
      workspaceId,
      documentId: "document-1",
      filename: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("abc"),
    });

    expect((await upload("workspace-1")).objectPath).toBe("workspaces/workspace-1/documents/document-1");
    await expect(upload("..")).rejects.toThrow();
    expect(client.files.map((file) => file.name)).toEqual(["workspaces/workspace-1/documents/document-1"]);
  });
});
