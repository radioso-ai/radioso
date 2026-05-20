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
});
