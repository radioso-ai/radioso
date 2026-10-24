import type { Storage } from "@google-cloud/storage";
import { describe, expect, it, vi } from "vitest";

import { GcsDocumentStorage } from "../../src/modules/documents/infra/gcsDocumentStorage.js";

/** Stands in for the Cloud Storage client: one bucket's listing and its files' deletes. */
const createClient = () => {
  const getFiles = vi.fn();
  const remove = vi.fn(async (_options?: unknown) => [{}]);
  const files: Array<{ bucket: string; name: string }> = [];
  const client = {
    bucket: (bucket: string) => ({
      getFiles,
      file: (name: string) => {
        files.push({ bucket, name });
        return { delete: remove };
      },
    }),
  };
  return { storage: client as unknown as Storage, getFiles, remove, files };
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
});
