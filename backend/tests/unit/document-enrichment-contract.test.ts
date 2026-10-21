import { describe, expect, it } from "vitest";

import type { DocumentTypeDefinition } from "../../src/modules/documentTypes/contracts/documentTypeCatalog.js";
import { builtInDocumentTypes } from "../../src/modules/documentTypes/domain/builtInDocumentTypes.js";
import {
  normalizeDocumentShape,
  parseDocumentEnrichmentOutput,
} from "../../src/modules/documents/domain/enrichment/documentEnrichmentContract.js";
import { buildDocumentEnrichmentOutputSchema } from "../../src/modules/documents/domain/enrichment/enrichmentOutputSchema.js";

const fact = (overrides: Record<string, unknown> = {}) => ({
  kind: "event_date",
  quote: "17-19 July 2026",
  dateFrom: "2026-07-17",
  dateTo: "2026-07-19",
  unresolvedText: null,
  ...overrides,
});

describe("document enrichment contract", () => {
  it("accepts one structured output containing the type and quoted temporal facts", () => {
    const parsed = parseDocumentEnrichmentOutput({ type: "event", confidence: 0.92, facts: [fact()] });

    expect(parsed.shape).toBe("event");
    expect(parsed.facts).toEqual([
      { kind: "event_date", quote: "17-19 July 2026", dateFrom: "2026-07-17", dateTo: "2026-07-19" },
    ]);
    expect(parsed.invalidFactCount).toBe(0);
  });

  it("drops and counts each invalid fact instead of rejecting the output", () => {
    const parsed = parseDocumentEnrichmentOutput({
      type: "event",
      confidence: 0.8,
      facts: [
        fact({ dateFrom: "2026-07-20", dateTo: "2026-07-19" }),
        fact({ dateFrom: "2026-02-31" }),
        fact({ quote: "" }),
        fact({ quote: undefined }),
        fact({ kind: "deadline" }),
        "not a fact",
        fact({ dateFrom: null, dateTo: null, unresolvedText: "next Saturday" }),
        fact(),
      ],
    });

    expect(parsed.invalidFactCount).toBe(6);
    expect(parsed.facts).toEqual([
      { kind: "event_date", quote: "17-19 July 2026", unresolvedText: "next Saturday" },
      { kind: "event_date", quote: "17-19 July 2026", dateFrom: "2026-07-17", dateTo: "2026-07-19" },
    ]);
  });

  it("ignores a fact with neither a date nor unresolved text without counting it", () => {
    const parsed = parseDocumentEnrichmentOutput({
      type: "event",
      confidence: 0.8,
      facts: [fact({ dateFrom: null, dateTo: null, unresolvedText: null }), fact({ dateFrom: "", unresolvedText: "" }), fact()],
    });

    expect(parsed.facts).toHaveLength(1);
    expect(parsed.invalidFactCount).toBe(0);
  });

  it("rejects output that is not an envelope", () => {
    expect(() => parseDocumentEnrichmentOutput(["event"])).toThrow();
    expect(() => parseDocumentEnrichmentOutput("event")).toThrow();
  });

  it("reads facts sent as a JSON-encoded list", () => {
    const parsed = parseDocumentEnrichmentOutput({ type: "event", confidence: 0.8, facts: JSON.stringify([fact()]) });

    expect(parsed.facts).toHaveLength(1);
    expect(parsed.invalidFactCount).toBe(0);
  });

  it("counts facts it cannot read as a list as one dropped fact instead of rejecting the reply", () => {
    for (const facts of ["17 July", "{\"kind\":\"event_date\"}", { kind: "event_date" }, 3]) {
      const parsed = parseDocumentEnrichmentOutput({ type: "event", confidence: 0.8, facts });

      expect(parsed).toMatchObject({ facts: [], invalidFactCount: 1 });
    }
    for (const facts of [null, undefined, ""]) {
      expect(parseDocumentEnrichmentOutput({ type: "event", confidence: 0.8, facts })).toMatchObject({ facts: [], invalidFactCount: 0 });
    }
  });

  it("normalizes unknown or low-confidence shapes to generic", () => {
    expect(normalizeDocumentShape("product", 0.95)).toBe("generic");
    expect(normalizeDocumentShape("event", 0.2)).toBe("generic");
    expect(normalizeDocumentShape("event", 0.8)).toBe("event");
  });
});

const productType: DocumentTypeDefinition = {
  key: "product",
  label: "Product",
  description: "A product detail page.",
  enabled: true,
  origin: "operator",
  payload: "fields",
  disableable: true,
  fields: [{ key: "price", label: "Price", valueType: "number", instruction: "The listed price." }],
};

type ObjectSchema = {
  type: string;
  additionalProperties: boolean;
  required: string[];
  properties: Record<string, { enum?: string[]; items?: ObjectSchema }>;
};

/** Strict structured output needs every object closed and every property required. */
const expectStrict = (schema: ObjectSchema) => {
  expect(schema.additionalProperties).toBe(false);
  expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort());
  for (const property of Object.values(schema.properties)) {
    if (property.items?.type === "object") {
      expectStrict(property.items);
    }
  }
};

describe("document enrichment output schema", () => {
  it("constrains the default catalog to its type keys and quoted facts", () => {
    const schema = buildDocumentEnrichmentOutputSchema(builtInDocumentTypes) as ObjectSchema;

    expectStrict(schema);
    expect(Object.keys(schema.properties)).toEqual(["type", "confidence", "facts"]);
    expect(schema.properties.type?.enum).toEqual(["event", "article", "profile", "reference", "generic"]);
    expect(Object.keys(schema.properties.facts?.items?.properties ?? {})).toEqual([
      "kind",
      "quote",
      "dateFrom",
      "dateTo",
      "unresolvedText",
    ]);
  });

  it("adds the fields payload only when an operator type declares fields", () => {
    const schema = buildDocumentEnrichmentOutputSchema([...builtInDocumentTypes, productType]) as ObjectSchema;

    expectStrict(schema);
    expect(Object.keys(schema.properties)).toEqual(["type", "confidence", "facts", "fields"]);
    expect(schema.properties.type?.enum).toContain("product");
  });

  it("leaves facts out when no enabled type carries them", () => {
    const schema = buildDocumentEnrichmentOutputSchema([
      ...builtInDocumentTypes.filter((type) => type.payload !== "facts"),
      productType,
    ]) as ObjectSchema;

    expect(Object.keys(schema.properties)).toEqual(["type", "confidence", "fields"]);
  });
});
