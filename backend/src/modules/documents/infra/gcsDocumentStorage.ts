import { Storage } from "@google-cloud/storage";
import {
  WORKSPACE_STORAGE_ROOT,
  workspaceStoragePrefix,
  type DocumentStorageAdapter,
  type DocumentStorageDeleteInput,
  type DocumentStorageReadInput,
  type DocumentStorageUploadInput,
  type DocumentStorageWorkspacePage,
  type DocumentStorageWorkspaceSummary,
  type StoredDocumentObject,
} from "../contracts/storage.js";

const WORKSPACES_PREFIX = `${WORKSPACE_STORAGE_ROOT}/`;

/** The "directories" a delimited listing returned, from the client's untyped API response. */
const listedPrefixes = (apiResponse: unknown): string[] => {
  if (!apiResponse || typeof apiResponse !== "object" || !("prefixes" in apiResponse)) return [];
  const { prefixes } = apiResponse;
  return Array.isArray(prefixes) ? prefixes.filter((prefix): prefix is string => typeof prefix === "string") : [];
};

/** Objects one summary listing page returns. */
const SUMMARY_PAGE_SIZE = 1_000;

/** When an object was last written, from its listed metadata; one with no time reads as written now. */
const writtenAt = (metadata: { updated?: unknown; timeCreated?: unknown } | undefined): number => {
  const recorded = [metadata?.updated, metadata?.timeCreated]
    .map((value) => (typeof value === "string" ? Date.parse(value) : Number.NaN))
    .filter((time) => Number.isFinite(time));
  return recorded.length > 0 ? Math.max(...recorded) : Date.now();
};

const nextPageToken = (nextQuery: unknown): string | null =>
  nextQuery && typeof nextQuery === "object" && "pageToken" in nextQuery && typeof nextQuery.pageToken === "string"
    ? nextQuery.pageToken
    : null;

export class GcsDocumentStorage implements DocumentStorageAdapter {
  private readonly storage: Storage;

  constructor(
    private readonly bucketName: string,
    options: { storage?: Storage } = {},
  ) {
    this.storage = options.storage ?? new Storage();
  }

  async upload(input: DocumentStorageUploadInput): Promise<StoredDocumentObject> {
    const bucket = this.storage.bucket(this.bucketName);
    // Path leaf is the caller-generated random documentId; the original
    // filename is untrusted client input, so it's kept on the document row's
    // `sourceFilename` rather than the storage path.
    const objectPath = `${workspaceStoragePrefix(input.workspaceId)}documents/${input.documentId}`;
    const file = bucket.file(objectPath);

    await file.save(input.buffer, {
      resumable: false,
      metadata: {
        contentType: input.mimeType,
      },
    });

    const [metadata] = await file.getMetadata();

    return {
      bucket: this.bucketName,
      objectPath,
      generation: metadata.generation != null ? String(metadata.generation) : null,
      sizeBytes: Number(metadata.size ?? input.buffer.length),
    };
  }

  async read(input: DocumentStorageReadInput): Promise<Buffer> {
    const file = this.storage.bucket(input.bucket).file(input.objectPath, {
      generation: input.generation ?? undefined,
    });
    const [buffer] = await file.download();
    return buffer;
  }

  async delete(input: DocumentStorageDeleteInput): Promise<void> {
    const file = this.storage.bucket(input.bucket).file(input.objectPath, {
      generation: input.generation ?? undefined,
    });
    await file.delete({ ignoreNotFound: true });
  }

  async listWorkspaceObjects(input: { workspaceId: string; limit: number }): Promise<DocumentStorageDeleteInput[]> {
    const prefix = workspaceStoragePrefix(input.workspaceId);
    const [files] = await this.storage.bucket(this.bucketName).getFiles({
      prefix,
      autoPaginate: false,
      maxResults: input.limit,
    });
    return files.map((file) => ({ bucket: this.bucketName, objectPath: file.name, generation: null }));
  }

  async summarizeWorkspaceObjects(input: { workspaceId: string }): Promise<DocumentStorageWorkspaceSummary> {
    const prefix = workspaceStoragePrefix(input.workspaceId);
    const bucket = this.storage.bucket(this.bucketName);
    let objectCount = 0;
    let newest: number | null = null;
    let pageToken: string | null = null;
    do {
      const [files, nextQuery] = await bucket.getFiles({
        prefix,
        autoPaginate: false,
        maxResults: SUMMARY_PAGE_SIZE,
        ...(pageToken === null ? {} : { pageToken }),
      });
      for (const file of files) {
        objectCount += 1;
        const time = writtenAt(file.metadata);
        newest = newest === null ? time : Math.max(newest, time);
      }
      pageToken = nextPageToken(nextQuery);
    } while (pageToken !== null);
    return { objectCount, newestObjectAt: newest === null ? null : new Date(newest) };
  }

  /** The cursor is the listing's own page token. */
  async listStoredWorkspaces(input: { cursor: string | null; limit: number }): Promise<DocumentStorageWorkspacePage> {
    const [, nextQuery, apiResponse] = await this.storage.bucket(this.bucketName).getFiles({
      prefix: WORKSPACES_PREFIX,
      delimiter: "/",
      autoPaginate: false,
      maxResults: input.limit,
      ...(input.cursor === null ? {} : { pageToken: input.cursor }),
    });
    return {
      workspaceIds: listedPrefixes(apiResponse)
        .filter((prefix) => prefix.startsWith(WORKSPACES_PREFIX) && prefix.endsWith("/"))
        .map((prefix) => prefix.slice(WORKSPACES_PREFIX.length, -1))
        .filter((workspaceId) => workspaceId.length > 0),
      nextCursor: nextPageToken(nextQuery),
    };
  }
}
