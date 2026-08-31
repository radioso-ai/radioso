import { z } from "zod";

/**
 * Document metadata is a flat map of scalars, bounded at 16 KB. Retrieval filters and boosts on
 * these values, so the shape and the ceiling are document rules rather than transport rules: every
 * writer — inline ingestion, import, the metadata PATCH, source-level tags, and an applied copilot
 * proposal — has to agree on them, not just the ones that happen to arrive over HTTP.
 */
export const MAX_DOCUMENT_METADATA_BYTES = 16384;

export const documentMetadataRecordSchema = z
  .record(z.union([z.string(), z.number(), z.boolean(), z.null()]))
  .refine(
    (value) => Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_DOCUMENT_METADATA_BYTES,
    { message: "Metadata must be 16 KB or less" },
  );

export type DocumentMetadataRecord = z.infer<typeof documentMetadataRecordSchema>;
