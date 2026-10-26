import { z } from "zod";

import { holdsValue } from "./metadataTags.js";

export const documentShapes = ["event", "article", "profile", "reference", "generic"] as const;
export type DocumentShape = (typeof documentShapes)[number];

export const enrichmentAnchorSources = ["source_last_sync", "document_created_at"] as const;
export type EnrichmentAnchorSource = (typeof enrichmentAnchorSources)[number];

export type EnrichmentStatus = "applied" | "skipped" | "failed";

/** Content-free tallies of what a run did with the model's `fields` payload. */
export interface DocumentEnrichmentFieldCounts {
  applied: number;
  droppedInvalid: number;
  droppedUndeclared: number;
  droppedDuplicate: number;
  droppedOverCap: number;
  skippedCollision: number;
}

export interface DocumentEnrichmentProvenance {
  status: EnrichmentStatus;
  shape?: DocumentShape;
  model?: string | null;
  enrichedAt?: string | null;
  anchorDate?: string | null;
  anchorSource?: EnrichmentAnchorSource | null;
  factCount?: number;
  /**
   * Facts the model returned that the run did not use: invalid ones, and ones
   * whose quoted text is in neither the body nor the title. Dropping a fact
   * never fails the run.
   */
  droppedFactCount?: number;
  appliedChunkCount?: number;
  failureReason?: string | null;
  /** The catalog type that matched. Equals `shape` for built-in entries. */
  matchedTypeKey?: string | null;
  /** The catalog revision the run resolved at execution time. */
  catalogRevision?: string | null;
  /**
   * The exact metadata keys this run generated, built-in `dateFrom`/`dateTo`
   * included. Extraction owns these and nothing else; the next successful run
   * removes them before writing its own.
   */
  generatedKeys?: string[];
  /**
   * `true` on every provenance a run or a relinquishing write produces:
   * `generatedKeys` then records ownership of `dateFrom`/`dateTo` as well.
   * Provenance without it never listed the dates, so their ownership is
   * inferred from the run it describes (see `resolveExtractionOwnedKeys`).
   */
  dateOwnershipRecorded?: boolean;
  fieldCounts?: DocumentEnrichmentFieldCounts | null;
  /**
   * Content-free note about a classification fallback on an otherwise
   * successful run — kept separate from `failureReason`, which stays reserved
   * for runs that failed.
   */
  classificationNote?: string | null;
  /**
   * `true` when the run applied the reply an earlier run got for the same
   * request instead of asking the model; `model` then names the model that
   * gave that reply.
   */
  reusedReply?: boolean;
}

// Shape alone is not enough: a model can emit a well-formed but calendar-invalid
// date such as 2026-02-31, which would later make the chunk insert fail inside the
// stored date columns. The UTC round-trip rejects any date the calendar
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

// Models routinely emit `null` for fields they were told are optional, and an
// empty string where they had nothing to say. Both mean "absent" here; date
// values themselves stay strictly validated.
const absentToUndefined = (value: unknown): unknown => (value === null || value === "" ? undefined : value);

export const temporalFactKinds = ["event_date", "article_date"] as const;

// The model locates a fact by quoting the text that states it; code finds the
// quote in the document. Models cannot count characters reliably, so a fact
// never carries offsets of its own.
const quotedTemporalFactSchema = z.object({
  kind: z.enum(temporalFactKinds),
  quote: z.string().trim().min(1),
  dateFrom: z.preprocess(absentToUndefined, isoDateSchema.optional()),
  dateTo: z.preprocess(absentToUndefined, isoDateSchema.optional()),
  unresolvedText: z.preprocess(absentToUndefined, z.string().min(1).optional()),
}).refine((fact) => fact.dateFrom || fact.unresolvedText, {
  message: "temporal fact requires a resolved date or unresolved text",
}).refine((fact) => !fact.dateFrom || !fact.dateTo || fact.dateFrom <= fact.dateTo, {
  message: "dateFrom must be before or equal to dateTo",
});

/** A temporal fact as the model states it: dated, and tied to the text it quotes. */
export interface QuotedTemporalFact {
  kind: (typeof temporalFactKinds)[number];
  quote: string;
  dateFrom?: string;
  dateTo?: string;
  unresolvedText?: string;
}

/**
 * A temporal fact placed in the document. `sourceRange` is the span of the
 * body, in the same offsets chunks use, that the fact was quoted from; `null`
 * means it was quoted from the title, so it dates the document as a whole and
 * sits on no particular chunk.
 */
export interface TemporalFact {
  kind: (typeof temporalFactKinds)[number];
  dateFrom?: string;
  dateTo?: string;
  unresolvedText?: string;
  sourceRange: { start: number; end: number } | null;
}

/**
 * The envelope names the matched catalog entry `type`. `shape` is accepted as
 * an alias so output produced against the previous contract still parses.
 * `typeKey` carries the raw key — an operator type is not a built-in shape, so
 * `shape` degrades to `generic` for it while `typeKey` keeps the match.
 */
const withEnvelopeAliases = (value: unknown): unknown => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const raw = value as Record<string, unknown>;
  const declared = typeof raw.type === "string" ? raw.type : raw.shape;
  return { ...raw, shape: raw.shape ?? raw.type, typeKey: declared };
};

const documentEnrichmentEnvelopeSchema = z.preprocess(withEnvelopeAliases, z.object({
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
  // Read and validated one at a time below: one bad fact, or a facts payload
  // that is not a list, costs only the facts, never the document.
  facts: z.unknown().optional(),
  typeKey: z.preprocess((value) => (typeof value === "string" ? value : ""), z.string()),
  // Kept as raw entries: every drop is counted in stage 2, so rejecting a
  // malformed entry here would fail a document that should merely lose a tag.
  fields: z.preprocess((value) => (Array.isArray(value) ? value : []), z.array(z.unknown()).default([])),
}));

// Explicit boundary type: zod's inference degrades through the preprocess
// wrappers above. The schema guarantees this shape at parse time.
export interface DocumentEnrichmentOutput {
  shape: DocumentShape;
  confidence: number;
  facts: QuotedTemporalFact[];
  /**
   * Facts the model returned that failed validation and were dropped; a facts
   * payload that is not a list counts as one.
   */
  invalidFactCount: number;
  /** The raw type key from the envelope; "" when the model named none. */
  typeKey: string;
  fields: unknown[];
}

/**
 * Parses the model's reply. Throws (a `ZodError`) only when the reply is not
 * an enrichment envelope at all; a fact that fails validation is dropped and
 * counted instead, so it never fails the run.
 */
/**
 * The reply's facts as a list. Absent or empty means none; a JSON-encoded list
 * is read as the list; anything else is a payload that could not be read.
 */
const readFactList = (value: unknown): { entries: unknown[]; unreadable: boolean } => {
  if (value === undefined || value === null || value === "") {
    return { entries: [], unreadable: false };
  }
  if (Array.isArray(value)) {
    return { entries: value, unreadable: false };
  }
  if (typeof value === "string") {
    try {
      const decoded: unknown = JSON.parse(value);
      if (Array.isArray(decoded)) {
        return { entries: decoded, unreadable: false };
      }
    } catch {
      // Prose rather than a list: unreadable, like any other non-list.
    }
  }
  return { entries: [], unreadable: true };
};

// Neither a date nor unresolved text is the model saying "nothing here"
// badly: ignored, and not counted as a dropped fact.
const isDegenerateFact = (value: unknown): boolean => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const fact = value as Record<string, unknown>;
  return !holdsValue(fact, "dateFrom") && !holdsValue(fact, "unresolvedText");
};

export const parseDocumentEnrichmentOutput = (value: unknown): DocumentEnrichmentOutput => {
  const envelope = documentEnrichmentEnvelopeSchema.parse(value) as unknown as Omit<DocumentEnrichmentOutput, "facts" | "invalidFactCount"> & {
    facts: unknown;
  };
  const list = readFactList(envelope.facts);
  const candidates = list.entries.filter((candidate) => !isDegenerateFact(candidate));
  const facts: QuotedTemporalFact[] = [];
  for (const candidate of candidates) {
    const parsed = quotedTemporalFactSchema.safeParse(candidate);
    if (parsed.success) {
      facts.push(parsed.data);
    }
  }
  const invalidFactCount = candidates.length - facts.length + (list.unreadable ? 1 : 0);
  return { ...envelope, facts, invalidFactCount };
};

export const MIN_DOCUMENT_TYPE_CONFIDENCE = 0.5;

const MIN_SHAPE_CONFIDENCE = MIN_DOCUMENT_TYPE_CONFIDENCE;

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
