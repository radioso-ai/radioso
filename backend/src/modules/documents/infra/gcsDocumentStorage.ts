import { Storage } from "@google-cloud/storage";
import type {
  DocumentStorageDeleteInput,
  DocumentStoragePort,
  DocumentStorageReadInput,
  DocumentStorageUploadInput,
  StoredDocumentObject,
} from "../contracts/storage.js";

export const sanitizePathSegment = (value: string): string =>
  value
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120) || "file";

export class GcsDocumentStorage implements DocumentStoragePort {
  private readonly storage: Storage;

  constructor(
    private readonly bucketName: string,
    options: { storage?: Storage } = {},
  ) {
    this.storage = options.storage ?? new Storage();
  }

  async upload(input: DocumentStorageUploadInput): Promise<StoredDocumentObject> {
    const bucket = this.storage.bucket(this.bucketName);
    const objectPath = [
      "workspaces",
      input.workspaceId,
      "documents",
      input.documentId,
      `${Date.now()}-${sanitizePathSegment(input.filename)}`,
    ].join("/");
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
    await file.delete();
  }
}
