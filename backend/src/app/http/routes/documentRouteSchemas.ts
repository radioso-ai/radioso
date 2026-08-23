import { z } from "zod";

const MAX_DOCUMENT_LIST_LIMIT = 100;
const MAX_DOCUMENT_METADATA_BYTES = 16384;

const crawlPatternSchema = z.array(z.string().trim().min(1).max(200)).max(50);

// Document metadata is a flat map of scalars, bounded at 16 KB. The same shape
// backs inline documents, imported documents, the document metadata PATCH, and
// source-level document tags, so it is declared once here.
export const documentMetadataRecordSchema = z
  .record(z.union([z.string(), z.number(), z.boolean(), z.null()]))
  .refine(
    (value) => Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_DOCUMENT_METADATA_BYTES,
    { message: "Metadata must be 16 KB or less" },
  );

export const documentEnrichmentOverrideSchema = z.enum(["on", "off"]);
export const documentSourceEnrichmentOverrideSchema = z.enum(["inherit", "on", "off"]);
export const reprocessDocumentBodySchema = z.object({
  documentEnrichmentOverride: documentEnrichmentOverrideSchema.optional(),
}).strict();

const documentSourceSchema = z.union([
  z.object({
    id: z.string().uuid(),
  }).strict(),
  z.object({
    kind: z.literal("website"),
    url: z.string().trim().url().refine((value) => {
      try {
        const parsed = new URL(value);
        return parsed.protocol === "http:" || parsed.protocol === "https:";
      } catch {
        return false;
      }
    }, "source.url must use http or https"),
  }).strict(),
]);

export const sourceParamsSchema = z.object({
  sourceId: z.string().uuid(),
});

export const sourceUpdateSchema = z.object({
  documentEnrichmentOverride: documentSourceEnrichmentOverrideSchema.optional(),
  // Tags stamped onto every chunk produced from this source's documents.
  documentMetadata: documentMetadataRecordSchema.optional(),
  crawlSettings: z
    .object({
      limit: z.number().int().min(1).optional(),
      includeUrlPatterns: crawlPatternSchema.optional(),
      excludeUrlPatterns: crawlPatternSchema.optional(),
      preserveContentLinks: z.boolean().optional(),
    })
    .refine(
      (value) =>
        value.limit !== undefined ||
        value.includeUrlPatterns !== undefined ||
        value.excludeUrlPatterns !== undefined ||
        value.preserveContentLinks !== undefined,
      { message: "crawlSettings must include at least one field" },
    )
    .optional(),
}).refine(
  (value) =>
    value.crawlSettings !== undefined ||
    value.documentEnrichmentOverride !== undefined ||
    value.documentMetadata !== undefined,
  { message: "source update must include at least one field" },
);

export const documentSchema = z.object({
  title: z.string().min(1),
  content: z.string().min(1),
  metadata: documentMetadataRecordSchema.optional(),
  externalDocumentId: z.string().trim().min(1).optional(),
  source: documentSourceSchema.optional(),
  documentEnrichmentOverride: documentEnrichmentOverrideSchema.optional(),
});

export const documentRetrievalUpdateSchema = z
  .object({
    retrievalEnabled: z.boolean().optional(),
    // `null` clears the expiry; an ISO 8601 timestamp sets it. Absent leaves the
    // stored value unchanged.
    retrievalExpiresAt: z.string().datetime({ offset: true }).nullable().optional(),
    // A full replace of the operator-authored tag map. Present-but-empty clears
    // every tag; absent leaves the stored map unchanged.
    metadata: documentMetadataRecordSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.retrievalEnabled !== undefined ||
      value.retrievalExpiresAt !== undefined ||
      value.metadata !== undefined,
    { message: "Provide retrievalEnabled, retrievalExpiresAt and/or metadata" },
  );

export const documentParamsSchema = z.object({
  documentId: z.string().uuid(),
});

export const documentSearchSchema = z.object({
  query: z.string().trim().min(1),
  metadataFilter: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  includeDebug: z.boolean().optional().default(false),
});

export const documentSearchHistoryParamsSchema = z.object({
  searchId: z.string().uuid(),
});

export const documentListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_DOCUMENT_LIST_LIMIT).default(MAX_DOCUMENT_LIST_LIMIT),
  offset: z.coerce.number().int().min(0).optional(),
  cursor: z.string().min(1).optional(),
});

export const chunkParamsSchema = z.object({
  documentId: z.string().uuid(),
  chunkId: z.string().uuid(),
});
