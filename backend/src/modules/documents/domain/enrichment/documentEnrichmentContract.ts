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

// Shape alone is not enough: a model can emit a well-formed but calendar-invalid
// date such as 2026-02-31, which would later make the chunk insert fail inside the
// generated date columns. The UTC round-trip rejects any date the calendar
// normalizes or refuses.
const isValidIsoCalendarDate = (value: string): boolean => {
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (Number.isNaN(timestamp)) {
    return false;
  }
  return new Date(timestamp).toISOString().slice(0, 10) === value;
};

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isValidIsoCalendarDate, { message: "must be a valid ISO calendar date" });

const sourceRangeSchema = z.object({
  start: z.coerce.number().int().min(0),
  end: z.coerce.number().int().min(1),
}).refine((range) => range.start < range.end, {
  message: "sourceRange.start must be less than sourceRange.end",
});

// Models routinely emit `null` for fields they were told are optional, and an
// empty string where they had nothing to say. Both mean "absent" here; date
// values themselves stay strictly validated.
const absentToUndefined = (value: unknown): unknown => (value === null || value === "" ? undefined : value);

const baseTemporalFactShape = {
  id: z.string().min(1),
  label: z.string().min(1),
  dateFrom: z.preprocess(absentToUndefined, isoDateSchema.optional()),
  dateTo: z.preprocess(absentToUndefined, isoDateSchema.optional()),
  unresolvedText: z.preprocess(absentToUndefined, z.string().min(1).optional()),
  sourceRange: sourceRangeSchema,
  anchorSource: z.preprocess(absentToUndefined, z.enum(enrichmentAnchorSources).optional()),
  anchorDate: z.preprocess(absentToUndefined, isoDateSchema.optional()),
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

// Explicit boundary type: zod's inference degrades through the preprocess
// wrappers above, and downstream strategies should not depend on it anyway.
export interface TemporalFact {
  kind: "event_date" | "article_date";
  id: string;
  label: string;
  dateFrom?: string;
  dateTo?: string;
  unresolvedText?: string;
  sourceRange: { start: number; end: number };
  anchorSource?: EnrichmentAnchorSource;
  anchorDate?: string;
}

export const documentEnrichmentOutputSchema = z.object({
  // Unknown shape labels degrade to generic (no extraction) instead of failing
  // the whole run; confidence clamps into range with a low default.
  shape: z.preprocess(
    (value) => (typeof value === "string" && documentShapes.includes(value as DocumentShape) ? value : "generic"),
    z.enum(documentShapes),
  ),
  confidence: z.preprocess(
    (value) => (typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5),
    z.number().min(0).max(1),
  ),
  facts: z.preprocess(
    // A degenerate fact (no resolved date and no unresolved text) is the model
    // saying "nothing here" badly — drop it rather than reject the document.
    (value) =>
      Array.isArray(value)
        ? value.filter(
            (fact) =>
              Boolean(fact) &&
              typeof fact === "object" &&
              (Boolean((fact as { dateFrom?: unknown }).dateFrom) ||
                Boolean((fact as { unresolvedText?: unknown }).unresolvedText)),
          )
        : value ?? [],
    z.array(temporalFactSchema).default([]),
  ),
});

// Explicit boundary type for the same reason as TemporalFact; the schema
// guarantees this shape at parse time.
export interface DocumentEnrichmentOutput {
  shape: DocumentShape;
  confidence: number;
  facts: TemporalFact[];
}

export const parseDocumentEnrichmentOutput = (value: unknown): DocumentEnrichmentOutput =>
  documentEnrichmentOutputSchema.parse(value) as unknown as DocumentEnrichmentOutput;

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
