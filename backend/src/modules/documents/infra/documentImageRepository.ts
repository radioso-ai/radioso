import type { Db } from "../../../shared/infra/kysely/types.js";
import type {
  DocumentImageEvidenceReader,
  DocumentImageObjectLookup,
  DocumentImageRole,
  StoredDocumentImageRef,
} from "../contracts/documentImages.js";
import type { StoredDocumentObject } from "../contracts/storage.js";

/** One stored copy of an image, as `document_images.renditions` lists them. */
interface StoredRendition {
  width: number;
  bucket: string;
  objectPath: string;
  generation?: string | null;
  sizeBytes: number;
}

const isStoredRendition = (value: unknown): value is StoredRendition => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.width === "number"
    && typeof record.bucket === "string"
    && typeof record.objectPath === "string"
    && typeof record.sizeBytes === "number";
};

const isRole = (value: string): value is DocumentImageRole => value === "primary" || value === "inline";

/**
 * The `document_images` rows: what an answer reads about a document's stored images, and the
 * stored copy the public image route serves. Only `stored` rows are ever read; a `pending` row
 * has no copy yet.
 */
export class DocumentImageRepository implements DocumentImageEvidenceReader, DocumentImageObjectLookup {
  constructor(private readonly db: Db) {}

  async listStoredForEvidence(input: {
    workspaceId: string;
    documentIds: readonly string[];
    chunkIds: readonly string[];
  }): Promise<StoredDocumentImageRef[]> {
    if (input.documentIds.length === 0 && input.chunkIds.length === 0) {
      return [];
    }
    const rows = await this.db
      .selectFrom("document_images")
      .select(["id", "document_id", "chunk_id", "role", "position", "alt", "caption", "width", "height", "sha256"])
      .where("workspace_id", "=", input.workspaceId)
      .where("status", "=", "stored")
      .where((eb) => eb.or([
        ...(input.documentIds.length > 0
          ? [eb.and([eb("role", "=", "primary"), eb("document_id", "in", [...input.documentIds])])]
          : []),
        ...(input.chunkIds.length > 0
          ? [eb.and([eb("role", "=", "inline"), eb("chunk_id", "in", [...input.chunkIds])])]
          : []),
      ]))
      .orderBy("document_id")
      .orderBy("position")
      .execute();
    return rows.flatMap((row) => {
      if (!isRole(row.role) || row.width === null || row.height === null || row.sha256 === null) {
        return [];
      }
      return [{
        id: row.id,
        documentId: row.document_id,
        chunkId: row.chunk_id,
        role: row.role,
        position: row.position,
        alt: row.alt,
        caption: row.caption,
        width: row.width,
        height: row.height,
        sha256: row.sha256,
      }];
    });
  }

  async findServable(input: { imageId: string; width: number }): Promise<StoredDocumentObject | null> {
    const row = await this.db
      .selectFrom("document_images")
      .select(["renditions"])
      .where("id", "=", input.imageId)
      .where("status", "=", "stored")
      .executeTakeFirst();
    const renditions: unknown = row?.renditions;
    const rendition = Array.isArray(renditions)
      ? renditions.find((entry): entry is StoredRendition => isStoredRendition(entry) && entry.width === input.width)
      : undefined;
    return rendition
      ? {
          bucket: rendition.bucket,
          objectPath: rendition.objectPath,
          generation: rendition.generation ?? null,
          sizeBytes: rendition.sizeBytes,
        }
      : null;
  }
}
