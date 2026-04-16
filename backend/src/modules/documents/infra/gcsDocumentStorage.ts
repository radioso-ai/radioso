import { Storage } from "@google-cloud/storage";

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

export interface DocumentStorageDeleteInput extends DocumentStorageReadInput {}

export interface DocumentStoragePort {
  upload(input: DocumentStorageUploadInput): Promise<StoredDocumentObject>;
  read(input: DocumentStorageReadInput): Promise<Buffer>;
  delete(input: DocumentStorageDeleteInput): Promise<void>;
}

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
