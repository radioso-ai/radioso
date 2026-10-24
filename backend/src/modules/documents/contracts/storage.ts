export interface StoredDocumentObject {
  bucket: string;
  objectPath: string;
  generation?: string | null;
  sizeBytes: number;
}

export interface DocumentStorageUploadInput {
  workspaceId: string;
  documentId: string;
  filename: string;
  mimeType: string;
  buffer: Buffer;
}

export interface DocumentStorageReadInput {
  bucket: string;
  objectPath: string;
  generation?: string | null;
}

export type DocumentStorageDeleteInput = DocumentStorageReadInput;

/** One page of the workspaces a store holds objects for. */
export interface DocumentStorageWorkspacePage {
  workspaceIds: string[];
  /** Passed back for the next page; null once the listing is complete. Opaque to callers. */
  nextCursor: string | null;
}

/** Where uploaded source files and assistant logos live, one object at a time. */
export interface DocumentStoragePort {
  upload(input: DocumentStorageUploadInput): Promise<StoredDocumentObject>;
  read(input: DocumentStorageReadInput): Promise<Buffer>;
  /** Deletes one object. An object that is already gone counts as deleted. */
  delete(input: DocumentStorageDeleteInput): Promise<void>;
}

/** How many objects a workspace holds, and when the newest of them was written. */
export interface DocumentStorageWorkspaceSummary {
  objectCount: number;
  /** Null when the workspace holds nothing. An object with no recorded write time counts as written now. */
  newestObjectAt: Date | null;
}

/**
 * What a store holds, by workspace. Every object an adapter writes sits under its workspace
 * (`workspaceStoragePrefix`), so a workspace's objects are found by its id alone, whatever path an
 * older release gave them below it.
 */
export interface DocumentStorageInventoryPort {
  /** Up to `limit` of the objects stored for one workspace. */
  listWorkspaceObjects(input: { workspaceId: string; limit: number }): Promise<DocumentStorageDeleteInput[]>;
  /** One page of at most `limit` workspaces holding at least one object. */
  listStoredWorkspaces(input: { cursor: string | null; limit: number }): Promise<DocumentStorageWorkspacePage>;
  /** Reads every object of one workspace, so its cost grows with what the workspace holds. */
  summarizeWorkspaceObjects(input: { workspaceId: string }): Promise<DocumentStorageWorkspaceSummary>;
}

/**
 * A store composition can wire: it serves single objects and answers what it holds, because a
 * deleted workspace's files are found through the inventory.
 */
export type DocumentStorageAdapter = DocumentStoragePort & DocumentStorageInventoryPort;

/**
 * What the database knows about the workspaces document storage holds objects for. Removing
 * stored files reads it so that only the files of a workspace the database no longer has go.
 */
export interface DocumentStorageOwnersPort {
  /** The ones among `workspaceIds` that still exist. */
  existingWorkspaceIds(workspaceIds: readonly string[]): Promise<ReadonlySet<string>>;
  /** Up to `limit` workspaces with a document whose uploaded file the store should hold, most recent first. */
  workspacesWithUploadedFiles(limit: number): Promise<string[]>;
}

/**
 * Where every object of a workspace lives: adapters derive upload paths and listings from it, so
 * the layout the inventory relies on is decided here alone. Accepts a workspace id only as one path
 * segment, so no id can widen an upload, a listing or a delete beyond its own workspace.
 * Structural: workspace ids are UUIDs.
 */
const STORAGE_WORKSPACE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export const workspaceStoragePrefix = (workspaceId: string): string => {
  if (!STORAGE_WORKSPACE_SEGMENT.test(workspaceId)) {
    throw new Error("Document storage needs a workspace id that is a single path segment");
  }
  return `workspaces/${workspaceId}/`;
};
