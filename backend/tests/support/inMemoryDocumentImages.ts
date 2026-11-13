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

/** A stored image as a test seeds it: the share count is derived, as the database derives it. */
type SeededImage = Omit<StoredDocumentImageRef, "primaryDocumentCount">;

/** Stored document images held in memory: what an answer's evidence reads, and what the image route serves. */
export class InMemoryDocumentImages implements DocumentImageEvidenceReader, DocumentImageObjectLookup {
  private readonly images = new Map<string, { workspaceId: string; ref: SeededImage; renditions: StoredRendition[] }>();

  add(workspaceId: string, ref: SeededImage, renditions: StoredRendition[] = []): void {
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
    const inWorkspace = [...this.images.values()].filter(({ workspaceId }) => workspaceId === input.workspaceId);
    const primaryDocumentCount = (ref: SeededImage): number => ref.role === "primary"
      ? new Set(inWorkspace
        .filter((entry) => entry.ref.role === "primary" && entry.ref.sha256 === ref.sha256)
        .map((entry) => entry.ref.documentId)).size
      : 0;
    return inWorkspace
      .filter(({ ref }) =>
        (ref.role === "primary" && input.documentIds.includes(ref.documentId))
        || (ref.role === "inline" && ref.chunkId !== null && input.chunkIds.includes(ref.chunkId)))
      .map(({ ref }) => ({ ...ref, primaryDocumentCount: primaryDocumentCount(ref) }));
  }

  async findServable(input: { imageId: string; width: number }) {
    const rendition = this.images.get(input.imageId)?.renditions.find((entry) => entry.width === input.width);
    return rendition
      ? { bucket: rendition.bucket, objectPath: rendition.objectPath, generation: rendition.generation, sizeBytes: rendition.sizeBytes }
      : null;
  }
}
