import { createHash } from "node:crypto";

import { normalizeMarkdown, renderMetadataSearchText } from "../../retrieval/public.js";
import type { IndexedFieldValue } from "../contracts/documentContracts.js";
import { sanitizeInlineDocumentContent } from "./inlineDocumentContentSanitizer.js";

// Indexed fields share the flat metadata map so operator rules address them by
// their bare key. The connector's own metadata is written last: a shop that
// publishes its own `author` or `dateFrom` must not overwrite what the
// connector derived for those platform-owned keys.
export const mergeIndexedFields = (
  metadata: Record<string, unknown> | undefined,
  indexedFields: Record<string, IndexedFieldValue> | undefined,
): Record<string, unknown> | undefined => {
  if (!indexedFields || Object.keys(indexedFields).length === 0) {
    return metadata;
  }
  return { ...indexedFields, ...(metadata ?? {}) };
};

// Key order is whatever the upstream happened to serialize, so sort before
// hashing or a reordered payload would look like an edit. Code-unit order
// rather than locale order: the same payload has to hash the same everywhere
// the worker runs.
//
// JSON rather than joined text, because the hash decides whether a re-sync is
// skipped and a value's type is part of what changed: a shop that starts
// sending the number 17 where it sent the string "17" changes what a numeric
// rule matches. JSON also escapes the value, so no field can spell out its
// neighbours and hash as them.
const renderIndexedFieldsFingerprint = (
  indexedFields: Record<string, IndexedFieldValue> | undefined,
): string => {
  const entries = Object.entries(indexedFields ?? {}).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  // An empty map has to render empty, so a document that carries no indexed
  // fields keeps the hash it already had.
  return entries.length > 0 ? JSON.stringify(entries) : "";
};

export const describeIndexedContent = (
  markdownContent: string,
  metadata?: Record<string, unknown>,
  indexedFields?: Record<string, IndexedFieldValue>,
): {
  markdownContent: string;
  contentSizeBytes: number;
  contentHash: string;
} => {
  const normalizedMarkdown = normalizeMarkdown(markdownContent);
  // The content hash gates whether a re-ingest reprocesses (re-chunks + re-embeds).
  // Fold the searchable metadata projection into it so a metadata-only change —
  // e.g. an author becoming available on a re-sync — still re-embeds; otherwise
  // the new metadata never reaches the embedded search text. Indexed fields join
  // it for the same reason: retrieval filters on them, so a price that moves
  // without a body edit has to reach the chunks. The rest of `metadata` stays
  // out — a modification stamp changes on every save and would re-embed
  // documents nobody edited. Size stays content-only so storage quota
  // accounting is unaffected.
  const fingerprint = [
    normalizedMarkdown,
    renderMetadataSearchText(metadata ?? {}),
    renderIndexedFieldsFingerprint(indexedFields),
  ]
    .filter((part) => part.length > 0)
    .join("\u0000");
  return {
    markdownContent: normalizedMarkdown,
    contentSizeBytes: Buffer.byteLength(normalizedMarkdown, "utf8"),
    contentHash: createHash("sha256").update(fingerprint, "utf8").digest("hex"),
  };
};

/** The identity-relevant projection shared by ingestion and owner-side import review. */
export const describeInlineDocumentForIngestion = (input: {
  readonly title: string;
  readonly content: string;
  readonly metadata?: Record<string, unknown>;
}) => {
  const sanitized = sanitizeInlineDocumentContent({
    title: input.title,
    sourceContent: input.content,
    metadata: input.metadata,
  });
  return describeIndexedContent(sanitized.markdownContent, input.metadata);
};
