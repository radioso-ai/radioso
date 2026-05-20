import fs from "node:fs/promises";
import path from "node:path";

import type {
  DocumentStorageDeleteInput,
  DocumentStoragePort,
  DocumentStorageReadInput,
  DocumentStorageUploadInput,
  StoredDocumentObject,
} from "../contracts/storage.js";

const LOCAL_STORAGE_BUCKET = "local";

const ensureWithinRoot = (rootPath: string, candidatePath: string): string => {
  const root = path.resolve(rootPath);
  const resolved = path.resolve(root, candidatePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("Document storage path escaped the configured local storage root");
  }
  return resolved;
};

const pruneEmptyParents = async (startPath: string, stopPath: string): Promise<void> => {
  let current = path.dirname(startPath);
  const root = path.resolve(stopPath);

  while (current.startsWith(root) && current !== root) {
    try {
      await fs.rmdir(current);
    } catch (error: any) {
      if (error?.code === "ENOTEMPTY" || error?.code === "ENOENT") {
        return;
      }
      throw error;
    }
    current = path.dirname(current);
  }
};

export class LocalDocumentStorage implements DocumentStoragePort {
  private readonly rootPath: string;

  constructor(rootPath: string) {
    this.rootPath = path.resolve(rootPath);
  }

  async upload(input: DocumentStorageUploadInput): Promise<StoredDocumentObject> {
    // Path leaf is the caller-generated random documentId; the original
    // filename is untrusted client input, so it's kept on the document row's
    // `sourceFilename` rather than the storage path.
    const objectPath = [
      "workspaces",
      input.workspaceId,
      "documents",
      input.documentId,
    ].join("/");
    const targetPath = ensureWithinRoot(this.rootPath, objectPath);

    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, input.buffer);

    return {
      bucket: LOCAL_STORAGE_BUCKET,
      objectPath,
      generation: null,
      sizeBytes: input.buffer.length,
    };
  }

  async read(input: DocumentStorageReadInput): Promise<Buffer> {
    const targetPath = ensureWithinRoot(this.rootPath, input.objectPath);
    return fs.readFile(targetPath);
  }

  async delete(input: DocumentStorageDeleteInput): Promise<void> {
    const targetPath = ensureWithinRoot(this.rootPath, input.objectPath);
    await fs.rm(targetPath, { force: true });
    await pruneEmptyParents(targetPath, this.rootPath);
  }
}
