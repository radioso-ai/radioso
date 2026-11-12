import type { StoredDocumentObject } from "./storage.js";

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
  }): Promise<StoredDocumentImageRef[]>;
}

/** Finds the stored copy the public image route serves for an image id and width. */
export interface DocumentImageObjectLookup {
  /** The rendition at `width` of a stored image, or null when there is none to serve. */
  findServable(input: { imageId: string; width: number }): Promise<StoredDocumentObject | null>;
}
