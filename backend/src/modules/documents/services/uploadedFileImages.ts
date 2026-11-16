import { createHash } from "node:crypto";

import {
  detectDocumentType,
  extractDocumentImages,
  type ExtractDocumentImagesInput,
  type ExtractedDocumentImages,
  type SupportedDocumentType,
} from "@radioso/document-parser";

import { errorSummaryOf } from "../../../shared/errors/errorReportShape.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import {
  MIN_DOCUMENT_IMAGE_SHORT_SIDE_PX,
  type DocumentImageCandidate,
  type DocumentImageCandidateWriter,
} from "../contracts/documentImages.js";
import type { DocumentStoragePort } from "../contracts/storage.js";
import { embeddedImageSource, MAX_INLINE_IMAGES, placeDocumentImages } from "../domain/documentImageCandidates.js";

/** What the capture job reads about a document to find the pictures its uploaded file carries. */
export interface UploadedDocumentFile {
  sourceKind?: string | null;
  sourceFilename?: string | null;
  sourceMimeType?: string | null;
  sourceStorageBucket?: string | null;
  sourceStorageObject?: string | null;
  sourceStorageGeneration?: string | null;
  /** The stored text the chunks are cut from. */
  markdownContent?: string;
}

/** Where an upload's pictures come from, as a bounded metric label. */
export type UploadedImageSource = "docx" | "pdf" | "markdown";

const IMAGE_SOURCES: Partial<Record<SupportedDocumentType, UploadedImageSource>> = { docx: "docx", pdf: "pdf", md: "markdown" };

/** Reads the pictures a file carries; the document parser's reader in production. */
type DocumentFileImageReader = (input: ExtractDocumentImagesInput) => Promise<ExtractedDocumentImages>;

/**
 * Bounds on reading one file's pictures. More than a document keeps, since a picture under the size
 * floor is only known once decoded; a PDF's share of the capture job's time; and the embedded bytes
 * the job holds at once before re-encoding them.
 */
const READ_LIMITS = {
  maxImages: MAX_INLINE_IMAGES,
  minShortSidePx: MIN_DOCUMENT_IMAGE_SHORT_SIDE_PX,
  maxImagesExamined: MAX_INLINE_IMAGES * 2,
  maxTotalBytes: 96 * 1024 * 1024,
  timeBudgetMs: 45_000,
} as const;

/** The kind of upload a document is, when its type carries pictures: null for any other document. */
export const uploadedImageSource = (document: UploadedDocumentFile): UploadedImageSource | null => {
  if (document.sourceKind !== "uploaded_file") return null;
  try {
    return IMAGE_SOURCES[detectDocumentType({ filename: document.sourceFilename, mimeType: document.sourceMimeType })] ?? null;
  } catch {
    return null;
  }
};

/** An upload's pictures as capture uses them: what the file is, and the bytes of each embedded one by its key. */
export interface UploadedFilePictures {
  source: UploadedImageSource;
  /** Empty when the file could not be read: the document's embedded images then wait for the next capture. */
  embedded: ReadonlyMap<string, Buffer>;
}

const toCandidate = (image: ExtractedDocumentImages["images"][number], embedded: Map<string, Buffer>): DocumentImageCandidate => {
  const placement = { role: "inline" as const, alt: image.alt, caption: image.caption, textOffset: image.textOffset };
  if (image.kind === "linked") return { sourceUrl: image.url, ...placement };
  const sourceUrl = embeddedImageSource(createHash("sha256").update(image.bytes).digest("hex"));
  embedded.set(sourceUrl, image.bytes);
  return { sourceUrl, ...placement };
};

/**
 * The pictures of an uploaded DOCX, PDF or markdown file, read by the capture job from the stored
 * file itself: the original bytes stay where the upload put them, and only the re-encoded copies
 * are ever written. Every capture records the file's pictures as the document's images, so a
 * re-processed file keeps the pictures it still carries (by the hash of their bytes, or the address
 * a markdown file links) and releases the rest, as a re-crawled page does.
 */
export class UploadedFileImages {
  constructor(private readonly deps: {
    storage: Pick<DocumentStoragePort, "read">;
    images: DocumentImageCandidateWriter;
    readImages?: DocumentFileImageReader;
    logger?: Pick<AppLogger, "warn">;
  }) {}

  /** Null when the document is not an upload whose type carries pictures. Never throws. */
  async record(input: { workspaceId: string; documentId: string; document: UploadedDocumentFile }): Promise<UploadedFilePictures | null> {
    const source = uploadedImageSource(input.document);
    if (!source) return null;
    const { document } = input;
    try {
      if (!document.sourceStorageBucket || !document.sourceStorageObject) throw new Error("The uploaded file has no stored object");
      const buffer = await this.deps.storage.read({
        bucket: document.sourceStorageBucket,
        objectPath: document.sourceStorageObject,
        generation: document.sourceStorageGeneration ?? null,
      });
      const read = await (this.deps.readImages ?? extractDocumentImages)({
        buffer,
        filename: document.sourceFilename,
        mimeType: document.sourceMimeType,
        limits: READ_LIMITS,
      });
      const embedded = new Map<string, Buffer>();
      const candidates = read.images.map((image) => toCandidate(image, embedded));
      await this.deps.images.recordCandidates({
        workspaceId: input.workspaceId,
        documentId: input.documentId,
        images: placeDocumentImages({ candidates, content: read.text, storedText: document.markdownContent ?? "", embedded: true }),
      });
      return { source, embedded };
    } catch (error) {
      this.deps.logger?.warn(
        { error: errorSummaryOf(error), workspaceId: input.workspaceId, documentId: input.documentId },
        "An uploaded file's pictures could not be read; its images wait for the next capture",
      );
      return { source, embedded: new Map() };
    }
  }
}
