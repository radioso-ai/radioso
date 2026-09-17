import { z } from "zod";

import {
  documentMetadataRecordSchema,
  documentEnrichmentOverrideSchema,
  documentRetrievalUpdateFieldsSchema,
  inlineDocumentFieldsSchema,
} from "../../../modules/documents/public.js";

const MAX_DOCUMENT_LIST_LIMIT = 100;

const crawlPatternSchema = z.array(z.string().trim().min(1).max(200)).max(50);

export { documentMetadataRecordSchema };

const documentSourceEnrichmentOverrideSchema = z.enum(["inherit", "on", "off"]);
export const reprocessDocumentBodySchema = z.object({
  documentEnrichmentOverride: documentEnrichmentOverrideSchema.optional(),
}).strict();

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

export const documentSchema = inlineDocumentFieldsSchema;

export const documentRetrievalUpdateSchema = documentRetrievalUpdateFieldsSchema
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
