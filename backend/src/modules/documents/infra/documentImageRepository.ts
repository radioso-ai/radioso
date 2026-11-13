import { sql } from "kysely";

import { currentTimestamp, toJsonb } from "../../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../../shared/infra/kysely/types.js";
import type {
  CapturableDocumentImage,
  DocumentImageCandidateWriter,
  DocumentImageCaptureStore,
  DocumentImageEvidenceReader,
  DocumentImageListing,
  DocumentImageObjectLookup,
  DocumentImageRendition,
  DocumentImageRole,
  DocumentImageStatus,
  DocumentImageSummary,
  PlacedDocumentImage,
  ReleasedDocumentImageStore,
  StoredDocumentImageRef,
} from "../contracts/documentImages.js";
import type { StoredDocumentObject } from "../contracts/storage.js";

const isRendition = (value: unknown): value is Record<string, unknown> & { width: number; bucket: string; objectPath: string; sizeBytes: number } => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.width === "number"
    && typeof record.bucket === "string"
    && typeof record.objectPath === "string"
    && typeof record.sizeBytes === "number";
};

/** The stored copies `document_images.renditions` lists; an entry that does not read as one is left out. */
const readRenditions = (value: unknown): DocumentImageRendition[] =>
  (Array.isArray(value) ? value : []).filter(isRendition).map((entry) => ({
    width: entry.width,
    height: typeof entry.height === "number" ? entry.height : 0,
    bucket: entry.bucket,
    objectPath: entry.objectPath,
    generation: typeof entry.generation === "string" ? entry.generation : null,
    sizeBytes: entry.sizeBytes,
  }));

const isRole = (value: string): value is DocumentImageRole => value === "primary" || value === "inline";
const isStatus = (value: string): value is DocumentImageStatus => value === "pending" || value === "stored" || value === "skipped";

/**
 * The `document_images` rows: the images ingestion records for a document, what the capture job
 * reads and fills, what an answer reads about the stored ones, and the stored copy the public
 * image route serves. Only `stored` rows of a live document are ever read for an answer or served;
 * a row whose document is gone (`document_id` NULL) waits for the worker's sweep.
 */
export class DocumentImageRepository implements
  DocumentImageEvidenceReader,
  DocumentImageObjectLookup,
  DocumentImageCandidateWriter,
  DocumentImageCaptureStore,
  DocumentImageListing,
  ReleasedDocumentImageStore {
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
      .selectFrom("document_images as image")
      .select(["image.id", "image.document_id", "image.chunk_id", "image.role", "image.position", "image.alt", "image.caption", "image.width", "image.height", "image.sha256"])
      // One indexed count per primary in the evidence: how many documents call the same picture their own.
      .select(sql<number>`CASE WHEN image.role = 'primary' THEN (
        SELECT count(DISTINCT other.document_id)::int
        FROM document_images AS other
        WHERE other.workspace_id = image.workspace_id
          AND other.sha256 = image.sha256
          AND other.status = 'stored'
          AND other.role = 'primary'
          AND other.document_id IS NOT NULL
      ) ELSE 0 END`.as("primary_document_count"))
      .where("image.workspace_id", "=", input.workspaceId)
      .where("image.status", "=", "stored")
      .where((eb) => eb.or([
        ...(input.documentIds.length > 0
          ? [eb.and([eb("image.role", "=", "primary"), eb("image.document_id", "in", [...input.documentIds])])]
          : []),
        ...(input.chunkIds.length > 0
          ? [eb.and([eb("image.role", "=", "inline"), eb("image.chunk_id", "in", [...input.chunkIds]), eb("image.document_id", "is not", null)])]
          : []),
      ]))
      .orderBy("image.document_id")
      .orderBy("image.position")
      .execute();
    return rows.flatMap((row) => {
      if (!isRole(row.role) || row.document_id === null || row.width === null || row.height === null || row.sha256 === null) {
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
        primaryDocumentCount: Number(row.primary_document_count),
      }];
    });
  }

  async findServable(input: { imageId: string; width: number }): Promise<StoredDocumentObject | null> {
    const row = await this.db
      .selectFrom("document_images")
      .select(["renditions"])
      .where("id", "=", input.imageId)
      .where("status", "=", "stored")
      .where("document_id", "is not", null)
      .executeTakeFirst();
    const rendition = readRenditions(row?.renditions).find((entry) => entry.width === input.width);
    return rendition
      ? { bucket: rendition.bucket, objectPath: rendition.objectPath, generation: rendition.generation, sizeBytes: rendition.sizeBytes }
      : null;
  }

  async recordCandidates(input: {
    workspaceId: string;
    documentId: string;
    images: readonly PlacedDocumentImage[];
  }): Promise<{ captureNeeded: boolean }> {
    return this.db.transaction().execute(async (trx) => {
      const existing = await trx
        .selectFrom("document_images")
        .select(["id", "source_url", "role", "text_offset"])
        .where("document_id", "=", input.documentId)
        .forUpdate()
        .execute();
      const byUrl = new Map(existing.map((row) => [row.source_url, row]));
      const named = new Set(input.images.map((image) => image.sourceUrl));
      const released = existing.filter((row) => !named.has(row.source_url)).map((row) => row.id);
      if (released.length > 0) {
        await trx
          .updateTable("document_images")
          .set({ document_id: null, updated_at: currentTimestamp() })
          .where("id", "in", released)
          .execute();
      }
      let captureNeeded = false;
      for (const image of input.images) {
        const kept = byUrl.get(image.sourceUrl);
        if (!kept) {
          const inserted = await trx
            .insertInto("document_images")
            .values({
              workspace_id: input.workspaceId,
              document_id: input.documentId,
              role: image.role,
              position: image.position,
              text_offset: image.textOffset,
              source_url: image.sourceUrl,
              alt: image.alt,
              caption: image.caption,
            })
            .onConflict((oc) => oc.columns(["document_id", "source_url"]).doNothing())
            .executeTakeFirst();
          captureNeeded ||= Number(inserted.numInsertedOrUpdatedRows ?? 0) > 0;
          continue;
        }
        // A kept image moves with its content: a new role or a new place in the text needs a new anchor.
        captureNeeded ||= kept.role !== image.role || (image.role === "inline" && kept.text_offset !== image.textOffset);
        await trx
          .updateTable("document_images")
          .set({
            role: image.role,
            position: image.position,
            text_offset: image.textOffset,
            alt: image.alt,
            caption: image.caption,
            updated_at: currentTimestamp(),
          })
          .where("id", "=", kept.id)
          .execute();
      }
      return { captureNeeded };
    });
  }

  async listForDocument(input: { workspaceId: string; documentId: string }): Promise<DocumentImageSummary[]> {
    const rows = await this.db
      .selectFrom("document_images")
      .select(["id", "role", "status", "alt", "caption", "width", "height", "source_url"])
      .where("workspace_id", "=", input.workspaceId)
      .where("document_id", "=", input.documentId)
      .orderBy("position")
      .execute();
    return rows.flatMap((row) => !isRole(row.role) || !isStatus(row.status)
      ? []
      : [{
          id: row.id,
          role: row.role,
          status: row.status,
          alt: row.alt,
          caption: row.caption,
          width: row.width,
          height: row.height,
          sourceUrl: row.source_url,
        }]);
  }

  async hasImages(documentId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("document_images")
      .select("id")
      .where("document_id", "=", documentId)
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }

  async listForCapture(input: { workspaceId: string; documentId: string }): Promise<CapturableDocumentImage[]> {
    const rows = await this.db
      .selectFrom("document_images")
      .select(["id", "role", "status", "position", "text_offset", "chunk_id", "source_url", "source_etag", "sha256", "renditions"])
      .where("workspace_id", "=", input.workspaceId)
      .where("document_id", "=", input.documentId)
      .orderBy("position")
      .execute();
    return rows.flatMap((row) => !isRole(row.role) || !isStatus(row.status)
      ? []
      : [{
          id: row.id,
          role: row.role,
          status: row.status,
          position: row.position,
          textOffset: row.text_offset,
          chunkId: row.chunk_id,
          sourceUrl: row.source_url,
          sourceEtag: row.source_etag,
          sha256: row.sha256,
          renditions: readRenditions(row.renditions),
        }]);
  }

  async markStored(input: {
    id: string;
    chunkId: string | null;
    width: number;
    height: number;
    sha256: string;
    sourceEtag: string | null;
    renditions: readonly DocumentImageRendition[];
  }): Promise<boolean> {
    const result = await this.db
      .updateTable("document_images")
      .set({
        status: "stored",
        chunk_id: input.chunkId,
        width: input.width,
        height: input.height,
        sha256: input.sha256,
        source_etag: input.sourceEtag,
        renditions: toJsonb(input.renditions),
        updated_at: currentTimestamp(),
      })
      .where("id", "=", input.id)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }

  async reanchor(input: { id: string; chunkId: string | null }): Promise<void> {
    await this.db
      .updateTable("document_images")
      .set({ chunk_id: input.chunkId, updated_at: currentTimestamp() })
      .where("id", "=", input.id)
      .execute();
  }

  async markSkipped(id: string): Promise<DocumentImageRendition[]> {
    return this.clearCopies(id, "skipped");
  }

  async resetToPending(id: string): Promise<DocumentImageRendition[]> {
    return this.clearCopies(id, "pending");
  }

  async listReleased(limit: number): Promise<Array<{ id: string; renditions: DocumentImageRendition[] }>> {
    const rows = await this.db
      .selectFrom("document_images")
      .select(["id", "renditions"])
      .where("document_id", "is", null)
      .orderBy("updated_at")
      .limit(limit)
      .execute();
    return rows.map((row) => ({ id: row.id, renditions: readRenditions(row.renditions) }));
  }

  async deleteReleased(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await this.db
      .deleteFrom("document_images")
      .where("id", "in", [...ids])
      .where("document_id", "is", null)
      .execute();
  }

  /** Leaves the row without copies; returns the ones it listed, for the caller to delete. */
  private async clearCopies(id: string, status: Exclude<DocumentImageStatus, "stored">): Promise<DocumentImageRendition[]> {
    return this.db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom("document_images")
        .select("renditions")
        .where("id", "=", id)
        .forUpdate()
        .executeTakeFirst();
      await trx
        .updateTable("document_images")
        .set({
          status,
          renditions: toJsonb([]),
          width: null,
          height: null,
          sha256: null,
          source_etag: null,
          updated_at: currentTimestamp(),
        })
        .where("id", "=", id)
        .execute();
      return readRenditions(row?.renditions);
    });
  }
}
