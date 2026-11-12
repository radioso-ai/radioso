import type {
  DocumentImageEvidenceReader,
  DocumentImageObjectLookup,
  StoredDocumentImageRef,
} from "../../src/modules/documents/contracts/index.js";

interface StoredRendition {
  width: number;
  bucket: string;
  objectPath: string;
  generation: string | null;
  sizeBytes: number;
}

/** Stored document images held in memory: what an answer's evidence reads, and what the image route serves. */
export class InMemoryDocumentImages implements DocumentImageEvidenceReader, DocumentImageObjectLookup {
  private readonly images = new Map<string, { workspaceId: string; ref: StoredDocumentImageRef; renditions: StoredRendition[] }>();

  add(workspaceId: string, ref: StoredDocumentImageRef, renditions: StoredRendition[] = []): void {
    this.images.set(ref.id, { workspaceId, ref, renditions });
  }

  delete(imageId: string): void {
    this.images.delete(imageId);
  }

  async listStoredForEvidence(input: {
    workspaceId: string;
    documentIds: readonly string[];
    chunkIds: readonly string[];
  }): Promise<StoredDocumentImageRef[]> {
    return [...this.images.values()]
      .filter(({ workspaceId, ref }) => workspaceId === input.workspaceId && (
        (ref.role === "primary" && input.documentIds.includes(ref.documentId))
        || (ref.role === "inline" && ref.chunkId !== null && input.chunkIds.includes(ref.chunkId))))
      .map(({ ref }) => ref);
  }

  async findServable(input: { imageId: string; width: number }) {
    const rendition = this.images.get(input.imageId)?.renditions.find((entry) => entry.width === input.width);
    return rendition
      ? { bucket: rendition.bucket, objectPath: rendition.objectPath, generation: rendition.generation, sizeBytes: rendition.sizeBytes }
      : null;
  }
}
