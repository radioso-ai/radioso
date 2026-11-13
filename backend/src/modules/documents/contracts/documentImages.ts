import type { StoredDocumentObject } from "./storage.js";

/** The widths in pixels every stored document image is re-encoded at, smallest first. */
export const DOCUMENT_IMAGE_RENDITION_WIDTHS = [320, 640] as const;

/**
 * A document keeps at most this many images, the first its content names that capture does not
 * skip; the rest wait, pending and unfetched, for a place to free up.
 */
export const MAX_STORED_IMAGES_PER_DOCUMENT = 12;


/**
 * Where an image sits in its document: `primary` is the one the document's metadata names (a
 * page's `og:image`, a featured image); `inline` appears in the text, anchored to a chunk.
 */
export type DocumentImageRole = "primary" | "inline";

/**
 * A stored image as an answer reads it: what it shows and where it sits in the document,
 * never where its bytes live.
 */
export interface StoredDocumentImageRef {
  /** Random; also the capability the public image route serves the image by. */
  id: string;
  documentId: string;
  /** The chunk an inline image is anchored to; null for a primary image or an unanchored one. */
  chunkId: string | null;
  role: DocumentImageRole;
  /** Order within the document. */
  position: number;
  alt: string;
  caption: string | null;
  width: number;
  height: number;
  sha256: string;
  /**
   * Primary only: how many documents in the workspace name an image with this content as their
   * own stored primary, this one included, counted no higher than the reader was asked to count.
   * Zero for an inline image.
   */
  primaryDocumentCount: number;
}

/** Reads the stored images an answer's evidence can present. */
export interface DocumentImageEvidenceReader {
  /**
   * The workspace's stored images that belong to the evidence: the primary images of
   * `documentIds` and the inline images anchored to `chunkIds`. Pending images are never
   * returned.
   */
  listStoredForEvidence(input: {
    workspaceId: string;
    documentIds: readonly string[];
    chunkIds: readonly string[];
    /** Where counting the documents that share a primary stops, so the count costs at most this many index reads. */
    primaryDocumentCountLimit: number;
  }): Promise<StoredDocumentImageRef[]>;
}

/** Finds the stored copy the public image route serves for an image id and width. */
export interface DocumentImageObjectLookup {
  /** The rendition at `width` of a stored image, or null when there is none to serve. */
  findServable(input: { imageId: string; width: number }): Promise<StoredDocumentObject | null>;
}

/**
 * An image a document's content names, as a source hands it to ingestion: an address and what the
 * content says about it, never its bytes.
 */
export interface DocumentImageCandidate {
  /** Absolute http(s) address. */
  sourceUrl: string;
  role: DocumentImageRole;
  alt?: string;
  caption?: string | null;
  /** Inline only: where the image sits, as an offset into the `content` handed to ingestion. */
  textOffset?: number | null;
}

/** A candidate as the document keeps it: in document order, and placed in the stored text. */
export interface PlacedDocumentImage {
  sourceUrl: string;
  role: DocumentImageRole;
  alt: string;
  caption: string | null;
  position: number;
  /** Inline only: an offset into the document's stored text, which the chunks' offsets index. */
  textOffset: number | null;
}

/** Records the images a document's content names, ahead of capture. */
export interface DocumentImageCandidateWriter {
  /**
   * Makes the document's rows match `images`, by address: a new address becomes a pending row, a
   * kept one takes its new place and text, and an address the content no longer names is released
   * for the sweep. `captureNeeded` is true when a new address or a moved inline image needs the
   * capture job.
   */
  recordCandidates(input: {
    workspaceId: string;
    documentId: string;
    images: readonly PlacedDocumentImage[];
  }): Promise<{ captureNeeded: boolean }>;
}

/** `skipped` is an image capture will not keep (too small, unreadable, refused); it is never shown and never fetched again. */
export type DocumentImageStatus = "pending" | "stored" | "skipped";

/** One stored copy of an image, as the row lists it. */
export interface DocumentImageRendition extends StoredDocumentObject {
  width: number;
  height: number;
  generation: string | null;
}

/** A document's image row, as the capture job reads it. */
export interface CapturableDocumentImage {
  id: string;
  role: DocumentImageRole;
  status: DocumentImageStatus;
  position: number;
  textOffset: number | null;
  chunkId: string | null;
  sourceUrl: string;
  sourceEtag: string | null;
  sha256: string | null;
  renditions: DocumentImageRendition[];
}

/** What the capture job reads and writes about a document's images. */
export interface DocumentImageCaptureStore {
  /** Whether the document names any image at all, so a document without one never queues capture. */
  hasImages(documentId: string): Promise<boolean>;
  listForCapture(input: { workspaceId: string; documentId: string }): Promise<CapturableDocumentImage[]>;
  /** False when the row is gone or its document released it; the caller then deletes the copies it wrote. */
  markStored(input: {
    id: string;
    chunkId: string | null;
    width: number;
    height: number;
    sha256: string;
    sourceEtag: string | null;
    renditions: readonly DocumentImageRendition[];
  }): Promise<boolean>;
  /** A stored image whose source did not change keeps its copies; only its anchor moves. A released row is left alone. */
  reanchor(input: { id: string; chunkId: string | null }): Promise<void>;
  /** Never shown or fetched again. Returns the copies a formerly stored image listed, to delete. */
  markSkipped(id: string): Promise<DocumentImageRendition[]>;
  /** Back to pending without copies, as when an image falls beyond the per-document limit. Returns the copies to delete. */
  resetToPending(id: string): Promise<DocumentImageRendition[]>;
}

/**
 * A document's image as its detail lists it: what the content names and whether capture kept it,
 * with the address of its stored copy once it did.
 */
export interface DocumentImageSummary {
  id: string;
  role: DocumentImageRole;
  status: DocumentImageStatus;
  alt: string;
  caption: string | null;
  /** The source's upright size; null until the image is stored. */
  width: number | null;
  height: number | null;
  sourceUrl: string;
  /** The stored copy's address at its widest width, and every width as a `srcset`; present once stored. */
  src?: string;
  srcSet?: string;
}

/** Lists a document's images, in document order, for its detail. */
export interface DocumentImageListing {
  listForDocument(input: { workspaceId: string; documentId: string }): Promise<DocumentImageSummary[]>;
}

/** The rows a deleted document, or a re-sync, released: their stored copies are deleted, then the rows. */
export interface ReleasedDocumentImageStore {
  /** Oldest first, by when each was released or last tried. */
  listReleased(limit: number): Promise<Array<{ id: string; renditions: DocumentImageRendition[] }>>;
  /** For rows whose copies did not all delete: they go to the back of the queue, to be tried again. */
  touchReleased(ids: readonly string[]): Promise<void>;
  deleteReleased(ids: readonly string[]): Promise<void>;
}
