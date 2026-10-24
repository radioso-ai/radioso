import fs from "node:fs/promises";
import path from "node:path";

import {
  workspaceStoragePrefix,
  type DocumentStorageAdapter,
  type DocumentStorageDeleteInput,
  type DocumentStorageReadInput,
  type DocumentStorageUploadInput,
  type DocumentStorageWorkspacePage,
  type DocumentStorageWorkspaceSummary,
  type StoredDocumentObject,
} from "../contracts/storage.js";

const LOCAL_STORAGE_BUCKET = "local";
const WORKSPACES_DIRECTORY = "workspaces";

const errorCode = (error: unknown): unknown =>
  error && typeof error === "object" && "code" in error ? error.code : undefined;

/** A directory's entries, or none when the directory does not exist. */
const readDirectory = async (directory: string, options: { recursive: boolean }) => {
  try {
    return await fs.readdir(directory, { withFileTypes: true, recursive: options.recursive });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
};

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
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
      if (code === "ENOTEMPTY" || code === "ENOENT") {
        return;
      }
      throw error;
    }
    current = path.dirname(current);
  }
};

export class LocalDocumentStorage implements DocumentStorageAdapter {
  private readonly rootPath: string;

  constructor(rootPath: string) {
    this.rootPath = path.resolve(rootPath);
  }

  async upload(input: DocumentStorageUploadInput): Promise<StoredDocumentObject> {
    // Path leaf is the caller-generated random documentId; the original
    // filename is untrusted client input, so it's kept on the document row's
    // `sourceFilename` rather than the storage path.
    const objectPath = `${workspaceStoragePrefix(input.workspaceId)}documents/${input.documentId}`;
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

  async listWorkspaceObjects(input: { workspaceId: string; limit: number }): Promise<DocumentStorageDeleteInput[]> {
    return (await this.workspaceObjectPaths(input.workspaceId))
      .slice(0, input.limit)
      .map((objectPath) => ({ bucket: LOCAL_STORAGE_BUCKET, objectPath, generation: null }));
  }

  async summarizeWorkspaceObjects(input: { workspaceId: string }): Promise<DocumentStorageWorkspaceSummary> {
    const objectPaths = await this.workspaceObjectPaths(input.workspaceId);
    let newest: number | null = null;
    for (const objectPath of objectPaths) {
      const { mtimeMs } = await fs.stat(ensureWithinRoot(this.rootPath, objectPath));
      newest = newest === null ? mtimeMs : Math.max(newest, mtimeMs);
    }
    return { objectCount: objectPaths.length, newestObjectAt: newest === null ? null : new Date(newest) };
  }

  private async workspaceObjectPaths(workspaceId: string): Promise<string[]> {
    const directory = ensureWithinRoot(this.rootPath, workspaceStoragePrefix(workspaceId));
    const entries = await readDirectory(directory, { recursive: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(this.rootPath, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
      .sort();
  }

  /** The cursor is the last workspace id of the previous page; directories list in name order. */
  async listStoredWorkspaces(input: { cursor: string | null; limit: number }): Promise<DocumentStorageWorkspacePage> {
    const entries = await readDirectory(ensureWithinRoot(this.rootPath, WORKSPACES_DIRECTORY), { recursive: false });
    const remaining = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .filter((workspaceId) => input.cursor === null || workspaceId > input.cursor);
    const workspaceIds = remaining.slice(0, input.limit);
    return {
      workspaceIds,
      nextCursor: remaining.length > workspaceIds.length ? workspaceIds.at(-1) ?? null : null,
    };
  }
}
