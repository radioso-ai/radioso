import type { DocumentImageRole, StoredDocumentImageRef } from "../../documents/contracts/index.js";
import { resolveContextSourceUrl } from "./contextSourceUrl.js";

/** At most this many images ride on one evidence item. */
const EVIDENCE_IMAGES_PER_ITEM = 3;

/**
 * Many sites name the same `og:image` on every page: a banner or a logo. A picture more than this
 * many documents in the workspace name as their own is the site's, not any one document's, so it
 * is never shown as a document's main picture. The rule is structural (how widely one picture is
 * shared), and it is read at answer time, so it follows documents as they come and go. A series
 * that shares a cover across a handful of volumes stays under it.
 */
const SITE_BANNER_PRIMARY_DOCUMENTS = 5;

/** How far the reader counts the documents that share a primary: one past the threshold settles the rule. */
export const PRIMARY_DOCUMENT_COUNT_LIMIT = SITE_BANNER_PRIMARY_DOCUMENTS + 1;

/** Whether a stored image is a site banner rather than its document's own main picture. */
export const isSiteBanner = (image: Pick<StoredDocumentImageRef, "role" | "primaryDocumentCount">): boolean =>
  image.role === "primary" && image.primaryDocumentCount > SITE_BANNER_PRIMARY_DOCUMENTS;

/** The part of an evidence item that decides which images it carries. */
export interface EvidenceContext {
  documentId: string;
  chunkId: string;
  /** The document's title, as the answer prompt names the item. */
  title: string;
  metadata?: Record<string, unknown>;
}

/** A stored image on an evidence item: what it shows, never where its bytes live. */
export interface EvidenceImage {
  imageId: string;
  role: DocumentImageRole;
  alt: string;
  caption: string | null;
  width: number;
  height: number;
  sha256: string;
}

/** An evidence item that carries images, numbered as the answer prompt numbers its Results. */
export interface EvidenceItemImages {
  /** The 1-based `Result N` the answer prompt shows this item as. */
  resultNumber: number;
  documentId: string;
  documentTitle: string;
  /** The document's http(s) address, when it has one. */
  sourceUrl?: string;
  /** Primary first, then inline images in document order. */
  images: EvidenceImage[];
}

const toEvidenceImage = (row: StoredDocumentImageRef): EvidenceImage => ({
  imageId: row.id,
  role: row.role,
  alt: row.alt,
  caption: row.caption,
  width: row.width,
  height: row.height,
  sha256: row.sha256,
});

const byPosition = (left: StoredDocumentImageRef, right: StoredDocumentImageRef): number => left.position - right.position;

/**
 * Which stored images each evidence item carries. A document's primary image rides once, on the
 * first item of that document; a site banner is never one, so the next primary stands in. An
 * inline image rides on the item whose chunk it is anchored to. Items keep the evidence order, and
 * an item without images is left out.
 */
export const assignEvidenceImages = (
  contexts: readonly EvidenceContext[],
  rows: readonly StoredDocumentImageRef[],
): EvidenceItemImages[] => {
  const sorted = rows.filter((row) => !isSiteBanner(row)).sort(byPosition);
  const primaryByDocument = new Map<string, StoredDocumentImageRef>();
  for (const row of sorted) {
    if (row.role === "primary" && !primaryByDocument.has(row.documentId)) {
      primaryByDocument.set(row.documentId, row);
    }
  }
  const seenDocuments = new Set<string>();
  return contexts.flatMap((context, index) => {
    const firstOfDocument = !seenDocuments.has(context.documentId);
    seenDocuments.add(context.documentId);
    const primary = firstOfDocument ? primaryByDocument.get(context.documentId) : undefined;
    const inline = sorted.filter((row) =>
      row.role === "inline" && row.documentId === context.documentId && row.chunkId === context.chunkId);
    const images = [...(primary ? [primary] : []), ...inline]
      .slice(0, EVIDENCE_IMAGES_PER_ITEM)
      .map(toEvidenceImage);
    if (images.length === 0) {
      return [];
    }
    const sourceUrl = resolveContextSourceUrl(context.metadata);
    return [{
      resultNumber: index + 1,
      documentId: context.documentId,
      documentTitle: context.title,
      ...(sourceUrl ? { sourceUrl } : {}),
      images,
    }];
  });
};
