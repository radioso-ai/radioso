import type { DocumentTypeDefinition } from "../../../documentTypes/public.js";
import { temporalFactKinds } from "./documentEnrichmentContract.js";

const nullable = (type: "string") => ({ type: [type, "null"] });

/** Every property required and nothing else allowed: what strict structured output accepts. */
const closedObject = (properties: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});

// Property order is generation order: the quote comes before the dates, so the
// model reads the evidence before it normalizes it.
const quotedFactSchema = closedObject({
  kind: { type: "string", enum: [...temporalFactKinds] },
  quote: { type: "string" },
  dateFrom: nullable("string"),
  dateTo: nullable("string"),
  unresolvedText: nullable("string"),
});

const fieldEntrySchema = closedObject({
  key: { type: "string" },
  value: { anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }] },
});

/**
 * The JSON Schema a reply must match for this catalog. It mirrors what
 * `parseDocumentEnrichmentOutput` reads: the envelope names one of the
 * catalog's keys, `facts` appears only when a dated type is enabled, and
 * `fields` only when an operator type declares fields. Value rules the schema
 * cannot express — calendar-valid dates, declared field types — stay with the
 * parser, which drops a bad entry rather than failing the run.
 */
export const buildDocumentEnrichmentOutputSchema = (
  types: readonly DocumentTypeDefinition[],
): Record<string, unknown> =>
  closedObject({
    type: { type: "string", enum: types.map((type) => type.key) },
    confidence: { type: "number" },
    ...(types.some((type) => type.payload === "facts") ? { facts: { type: "array", items: quotedFactSchema } } : {}),
    ...(types.some((type) => type.payload === "fields" && type.fields.length > 0)
      ? { fields: { type: "array", items: fieldEntrySchema } }
      : {}),
  });
