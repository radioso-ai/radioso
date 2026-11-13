import { randomUUID } from "node:crypto";

import { hasPendingKeptImage } from "../../src/modules/documents/domain/documentImageCandidates.js";
import type {
  CapturableDocumentImage,
  DocumentImageCandidateWriter,
  DocumentImageCaptureStore,
  DocumentImageRendition,
  DocumentImageRows,
  ListedDocumentImage,
  PlacedDocumentImage,
  ReleasedDocumentImageStore,
} from "../../src/modules/documents/contracts/index.js";

interface Row extends CapturableDocumentImage {
  workspaceId: string;
  /** Null once the document released it. */
  documentId: string | null;
  alt: string;
  caption: string | null;
  width: number | null;
  height: number | null;
}

/** `document_images` rows held in memory, with the writer, capture and sweep semantics of the repository. */
export class InMemoryDocumentImageRows implements DocumentImageCandidateWriter, DocumentImageCaptureStore, DocumentImageRows, ReleasedDocumentImageStore {
  readonly rows = new Map<string, Row>();

  seed(row: Partial<Row> & Pick<Row, "workspaceId" | "documentId" | "sourceUrl" | "role">): Row {
    const full: Row = {
      id: randomUUID(),
      status: "pending",
      position: this.rows.size,
      textOffset: null,
      chunkId: null,
      sourceEtag: null,
      sha256: null,
      renditions: [],
      alt: "",
      caption: null,
      width: null,
      height: null,
      ...row,
    };
    this.rows.set(full.id, full);
    return full;
  }

  forDocument(documentId: string): Row[] {
    return [...this.rows.values()].filter((row) => row.documentId === documentId).sort((left, right) => left.position - right.position);
  }

  byUrl(sourceUrl: string): Row | undefined {
    return [...this.rows.values()].find((row) => row.sourceUrl === sourceUrl);
  }

  async recordCandidates(input: { workspaceId: string; documentId: string; images: readonly PlacedDocumentImage[] }) {
    const existing = this.forDocument(input.documentId);
    const named = new Set(input.images.map((image) => image.sourceUrl));
    for (const row of existing) {
      if (!named.has(row.sourceUrl)) row.documentId = null;
    }
    let captureNeeded = hasPendingKeptImage(input.images.map((image) => ({
      position: image.position,
      status: existing.find((row) => row.sourceUrl === image.sourceUrl)?.status ?? "pending",
    })));
    for (const image of input.images) {
      const kept = existing.find((row) => row.sourceUrl === image.sourceUrl);
      if (!kept) {
        this.seed({ workspaceId: input.workspaceId, documentId: input.documentId, ...image });
        captureNeeded = true;
        continue;
      }
      captureNeeded ||= kept.role !== image.role || (image.role === "inline" && kept.textOffset !== image.textOffset);
      Object.assign(kept, { role: image.role, position: image.position, textOffset: image.textOffset, alt: image.alt, caption: image.caption });
    }
    return { captureNeeded };
  }

  async listForDocument(input: { workspaceId: string; documentId: string; primaryDocumentCountLimit: number }): Promise<ListedDocumentImage[]> {
    const sharing = (row: Row): number => row.role === "primary" && row.status === "stored"
      ? Math.min(input.primaryDocumentCountLimit, new Set([...this.rows.values()]
        .filter((other) => other.workspaceId === row.workspaceId && other.documentId !== null && other.role === "primary"
          && other.status === "stored" && other.sha256 === row.sha256)
        .map((other) => other.documentId)).size)
      : 0;
    return this.forDocument(input.documentId)
      .filter((row) => row.workspaceId === input.workspaceId)
      .map((row) => ({
        id: row.id, role: row.role, status: row.status, alt: row.alt, caption: row.caption, width: row.width, height: row.height,
        sourceUrl: row.sourceUrl, primaryDocumentCount: sharing(row),
      }));
  }

  async hasImages(documentId: string): Promise<boolean> {
    return this.forDocument(documentId).length > 0;
  }

  async listForCapture(input: { workspaceId: string; documentId: string }): Promise<CapturableDocumentImage[]> {
    return this.forDocument(input.documentId)
      .filter((row) => row.workspaceId === input.workspaceId)
      .map((row) => ({ ...row, renditions: [...row.renditions] }));
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
    const row = this.rows.get(input.id);
    if (!row || row.documentId === null) return false;
    Object.assign(row, { ...input, status: "stored", renditions: [...input.renditions] });
    return true;
  }

  async reanchor(input: { id: string; chunkId: string | null }): Promise<void> {
    const row = this.rows.get(input.id);
    if (row && row.documentId !== null) row.chunkId = input.chunkId;
  }

  async markSkipped(id: string): Promise<DocumentImageRendition[]> {
    return this.clear(id, "skipped");
  }

  async resetToPending(id: string): Promise<DocumentImageRendition[]> {
    return this.clear(id, "pending");
  }

  async listReleased(limit: number) {
    return [...this.rows.values()]
      .filter((row) => row.documentId === null)
      .slice(0, limit)
      .map((row) => ({ id: row.id, renditions: [...row.renditions] }));
  }

  /** Sends rows to the back of the sweep's queue, as a fresh `updated_at` does. */
  async touchReleased(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      const row = this.rows.get(id);
      if (!row || row.documentId !== null) continue;
      this.rows.delete(id);
      this.rows.set(id, row);
    }
  }

  async deleteReleased(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      if (this.rows.get(id)?.documentId === null) this.rows.delete(id);
    }
  }

  private clear(id: string, status: "pending" | "skipped"): DocumentImageRendition[] {
    const row = this.rows.get(id);
    if (!row) return [];
    const renditions = row.renditions;
    Object.assign(row, { status, renditions: [], width: null, height: null, sha256: null, sourceEtag: null });
    return renditions;
  }
}
