export type DocumentMetadataValue = string | number | boolean | null;
export type DocumentMetadataRecord = Record<string, DocumentMetadataValue>;

const isScalar = (value: unknown): value is DocumentMetadataValue =>
  value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";

/**
 * Reads the operator-authored tag map off a document source's untyped JSONB
 * config. Non-scalar values are dropped rather than trusted: the column is
 * schema-less, so a malformed row must not reach the chunk projection.
 */
export const parseSourceDocumentMetadata = (config: unknown): DocumentMetadataRecord => {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return {};
  }
  const raw = (config as Record<string, unknown>).documentMetadata;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }

  const parsed: DocumentMetadataRecord = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isScalar(value)) {
      parsed[key] = value;
    }
  }
  return parsed;
};

/**
 * Builds the metadata map stamped onto a document's chunks. Source tags are the
 * base layer and a document's own metadata wins on key collisions, so a single
 * document can always override what its source asserts about it.
 */
export const mergeDocumentMetadataForChunks = (
  sourceDocumentMetadata: Record<string, unknown>,
  documentOwnMetadata: Record<string, unknown>,
): Record<string, unknown> => ({
  ...sourceDocumentMetadata,
  ...documentOwnMetadata,
});
