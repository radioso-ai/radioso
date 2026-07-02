import { z } from "zod";

export const documentShapes = ["event", "article", "profile", "reference", "generic"] as const;
export type DocumentShape = (typeof documentShapes)[number];

export const enrichmentAnchorSources = ["source_last_sync", "document_created_at"] as const;
export type EnrichmentAnchorSource = (typeof enrichmentAnchorSources)[number];

export type EnrichmentStatus = "applied" | "skipped" | "failed";

export interface DocumentEnrichmentProvenance {
  status: EnrichmentStatus;
  shape?: DocumentShape;
  model?: string | null;
  enrichedAt?: string | null;
  anchorDate?: string | null;
  anchorSource?: EnrichmentAnchorSource | null;
  factCount?: number;
  appliedChunkCount?: number;
  failureReason?: string | null;
}

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const sourceRangeSchema = z.object({
  start: z.number().int().min(0),
  end: z.number().int().min(1),
}).refine((range) => range.start < range.end, {
  message: "sourceRange.start must be less than sourceRange.end",
});

const baseTemporalFactShape = {
  id: z.string().min(1),
  label: z.string().min(1),
  dateFrom: isoDateSchema.optional(),
  dateTo: isoDateSchema.optional(),
  unresolvedText: z.string().min(1).optional(),
  sourceRange: sourceRangeSchema,
  anchorSource: z.enum(enrichmentAnchorSources).optional(),
  anchorDate: isoDateSchema.optional(),
};

const withTemporalFactRules = <T extends z.AnyZodObject>(schema: T) => schema.refine((fact) => fact.dateFrom || fact.unresolvedText, {
  message: "temporal fact requires a resolved date or unresolved text",
}).refine((fact) => !fact.dateFrom || !fact.dateTo || fact.dateFrom <= fact.dateTo, {
  message: "dateFrom must be before or equal to dateTo",
});

export const temporalFactSchema = z.union([
  withTemporalFactRules(z.object({ kind: z.literal("event_date"), ...baseTemporalFactShape })),
  withTemporalFactRules(z.object({ kind: z.literal("article_date"), ...baseTemporalFactShape })),
]);

export type TemporalFact = z.infer<typeof temporalFactSchema>;

export const documentEnrichmentOutputSchema = z.object({
  shape: z.enum(documentShapes),
  confidence: z.number().min(0).max(1),
  facts: z.array(temporalFactSchema).default([]),
});

export type DocumentEnrichmentOutput = z.infer<typeof documentEnrichmentOutputSchema>;

const MIN_SHAPE_CONFIDENCE = 0.5;

export const normalizeDocumentShape = (shape: unknown, confidence: number): DocumentShape => {
  if (confidence < MIN_SHAPE_CONFIDENCE) {
    return "generic";
  }
  return typeof shape === "string" && documentShapes.includes(shape as DocumentShape)
    ? shape as DocumentShape
    : "generic";
};

export const isDocumentEnrichmentProvenance = (value: unknown): value is DocumentEnrichmentProvenance => {
  if (!value || typeof value !== "object") {
    return false;
  }
  const status = (value as { status?: unknown }).status;
  return status === "applied" || status === "skipped" || status === "failed";
};
