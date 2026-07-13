import { describe, expect, it } from "vitest";

import {
  documentEnrichmentOutputSchema,
  normalizeDocumentShape,
} from "../../src/modules/documents/domain/enrichment/documentEnrichmentContract.js";

describe("document enrichment contract", () => {
  it("accepts one structured output containing shape and event temporal facts", () => {
    const parsed = documentEnrichmentOutputSchema.parse({
      shape: "event",
      confidence: 0.92,
      facts: [
        {
          id: "summer-workshop",
          kind: "event_date",
          label: "summer workshop",
          dateFrom: "2026-07-17",
          dateTo: "2026-07-19",
          sourceRange: { start: 12, end: 83 },
          anchorSource: "document_created_at",
          anchorDate: "2026-07-02",
        },
      ],
    });

    expect(parsed.shape).toBe("event");
    expect(parsed.facts[0]?.dateFrom).toBe("2026-07-17");
  });

  it("rejects invalid temporal ranges instead of letting them reach metadata", () => {
    expect(() =>
      documentEnrichmentOutputSchema.parse({
        shape: "event",
        confidence: 0.8,
        facts: [
          {
            id: "bad-range",
            kind: "event_date",
            label: "bad range",
            dateFrom: "2026-07-20",
            dateTo: "2026-07-19",
            sourceRange: { start: 40, end: 12 },
          },
        ],
      }),
    ).toThrow();
  });

  it("accepts numeric string source ranges from structured model output", () => {
    const parsed = documentEnrichmentOutputSchema.parse({
      shape: "event",
      confidence: 0.8,
      facts: [
        {
          id: "string-range",
          kind: "event_date",
          label: "string range",
          dateFrom: "2026-07-20",
          sourceRange: { start: "40", end: "120" },
        },
      ],
    });

    expect(parsed.facts[0]?.sourceRange).toEqual({ start: 40, end: 120 });
  });

  it("rejects calendar-invalid dates that pass the ISO shape check", () => {
    // 2026-02-31 is shaped like an ISO date, but letting it through would later
    // fail the chunk insert inside the generated date columns (to_date raises).
    expect(() =>
      documentEnrichmentOutputSchema.parse({
        shape: "event",
        confidence: 0.8,
        facts: [
          {
            id: "bad-calendar-date",
            kind: "event_date",
            label: "impossible february day",
            dateFrom: "2026-02-31",
            sourceRange: { start: 0, end: 10 },
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      documentEnrichmentOutputSchema.parse({
        shape: "event",
        confidence: 0.8,
        facts: [
          {
            id: "bad-anchor",
            kind: "event_date",
            label: "valid date, invalid anchor",
            dateFrom: "2026-07-10",
            anchorDate: "2026-11-31",
            sourceRange: { start: 0, end: 10 },
          },
        ],
      }),
    ).toThrow();
  });

  it("normalizes unknown or low-confidence shapes to generic", () => {
    expect(normalizeDocumentShape("product", 0.95)).toBe("generic");
    expect(normalizeDocumentShape("event", 0.2)).toBe("generic");
    expect(normalizeDocumentShape("event", 0.8)).toBe("event");
  });
});
