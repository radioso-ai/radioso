import { z } from "zod";

const MAX_DOCUMENT_LIST_LIMIT = 100;
const MAX_DOCUMENT_METADATA_BYTES = 16384;

const crawlPatternSchema = z.array(z.string().trim().min(1).max(200)).max(50);

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
});

export const documentSchema = z.object({
  title: z.string().min(1),
  content: z.string().min(1),
  metadata: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional().refine(
    (val) => !val || Buffer.byteLength(JSON.stringify(val), "utf8") <= MAX_DOCUMENT_METADATA_BYTES,
    { message: "Metadata must be 16 KB or less" },
  ),
  externalDocumentId: z.string().trim().min(1).optional(),
  source: documentSourceSchema.optional(),
});

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
