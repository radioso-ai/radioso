import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LocalDocumentStorage } from "../../src/modules/documents/infra/localDocumentStorage.js";

describe("LocalDocumentStorage", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  it("stores, reads, and deletes uploaded documents under the configured root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "radioso-local-storage-"));
    tempRoots.push(root);

    const storage = new LocalDocumentStorage(root);
    const uploaded = await storage.upload({
      workspaceId: "workspace-1",
      documentId: "document-1",
      filename: "Quarterly Report.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("hello local storage"),
    });

    expect(uploaded.bucket).toBe("local");
    expect(uploaded.objectPath).toBe("workspaces/workspace-1/documents/document-1");
    expect(uploaded.objectPath).not.toContain("Quarterly");
    expect(uploaded.sizeBytes).toBe(Buffer.byteLength("hello local storage"));

    const buffer = await storage.read({
      bucket: uploaded.bucket,
      objectPath: uploaded.objectPath,
      generation: uploaded.generation,
    });
    expect(buffer.toString("utf8")).toBe("hello local storage");

    await storage.delete({
      bucket: uploaded.bucket,
      objectPath: uploaded.objectPath,
      generation: uploaded.generation,
    });

    await expect(storage.read({
      bucket: uploaded.bucket,
      objectPath: uploaded.objectPath,
      generation: uploaded.generation,
    })).rejects.toMatchObject({ code: "ENOENT" });
  });

  const createStorage = async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "radioso-local-storage-"));
    tempRoots.push(root);
    return { root, storage: new LocalDocumentStorage(root) };
  };

  const upload = (storage: LocalDocumentStorage, workspaceId: string, documentId: string) =>
    storage.upload({
      workspaceId,
      documentId,
      filename: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(documentId),
    });

  it("lists a workspace's objects, files from the older nested layout included, a bounded page at a time", async () => {
    const { root, storage } = await createStorage();
    await upload(storage, "workspace-1", "document-b");
    await upload(storage, "workspace-1", "document-a");
    await upload(storage, "workspace-2", "document-c");
    const legacy = path.join(root, "workspaces", "workspace-1", "documents", "document-d", "1716000000000-report.pdf");
    await fs.mkdir(path.dirname(legacy), { recursive: true });
    await fs.writeFile(legacy, "legacy");

    expect(await storage.listWorkspaceObjects({ workspaceId: "workspace-1", limit: 10 })).toEqual([
      { bucket: "local", objectPath: "workspaces/workspace-1/documents/document-a", generation: null },
      { bucket: "local", objectPath: "workspaces/workspace-1/documents/document-b", generation: null },
      { bucket: "local", objectPath: "workspaces/workspace-1/documents/document-d/1716000000000-report.pdf", generation: null },
    ]);
    expect(await storage.listWorkspaceObjects({ workspaceId: "workspace-1", limit: 2 })).toHaveLength(2);
    expect(await storage.listWorkspaceObjects({ workspaceId: "workspace-3", limit: 10 })).toEqual([]);
  });

  it("lists the workspaces it holds objects for, page by page", async () => {
    const { storage } = await createStorage();
    expect(await storage.listStoredWorkspaces({ cursor: null, limit: 2 })).toEqual({ workspaceIds: [], nextCursor: null });

    await upload(storage, "workspace-c", "document-1");
    await upload(storage, "workspace-a", "document-2");
    await upload(storage, "workspace-b", "document-3");

    const first = await storage.listStoredWorkspaces({ cursor: null, limit: 2 });
    expect(first.workspaceIds).toEqual(["workspace-a", "workspace-b"]);
    expect(first.nextCursor).not.toBeNull();
    expect(await storage.listStoredWorkspaces({ cursor: first.nextCursor, limit: 2 }))
      .toEqual({ workspaceIds: ["workspace-c"], nextCursor: null });
  });

  it("treats deleting an object that is already gone as done, and stops listing a workspace it emptied", async () => {
    const { storage } = await createStorage();
    const uploaded = await upload(storage, "workspace-1", "document-1");

    await storage.delete(uploaded);
    await expect(storage.delete(uploaded)).resolves.toBeUndefined();
    expect(await storage.listStoredWorkspaces({ cursor: null, limit: 10 })).toEqual({ workspaceIds: [], nextCursor: null });
  });

  it("refuses a workspace id that is not a single path segment", async () => {
    const { storage } = await createStorage();
    await upload(storage, "workspace-1", "document-1");

    for (const workspaceId of ["..", ".", "", "workspace-1/documents", "../workspaces"]) {
      await expect(storage.listWorkspaceObjects({ workspaceId, limit: 10 })).rejects.toThrow();
    }
  });
});
