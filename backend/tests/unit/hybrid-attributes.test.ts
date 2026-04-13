import { describe, expect, it } from "vitest";

import { CompositeDocumentAttributeExtractionService } from "../../src/modules/retrieval/services/documentAttributeExtractionService.js";

describe("hybrid attributes", () => {
  it("extracts structured dates from metadata without depending on content regexes", async () => {
    const attributes = await new CompositeDocumentAttributeExtractionService().extract({
      title: "Summer Retreat",
      content: "Retreat dates: 2026-06-12 to 2026-06-15. Price: 290 EUR. Location: Estonia.",
      metadata: {
        dateFrom: "2026-06-12",
        dateTo: "2026-06-15",
      },
    });

    expect(attributes.dateRanges).toEqual([
      {
        start: "2026-06-12",
        end: "2026-06-15",
        confidence: 1,
        sourceText: "metadata.dateFrom/dateTo",
      },
    ]);
    expect(attributes.datePoints).toEqual([]);
    expect(attributes.moneyValues).toEqual([]);
    expect(attributes.locations).toEqual([]);
  });

  it("does not infer location from prose without explicit metadata or semantic extraction", async () => {
    const attributes = await new CompositeDocumentAttributeExtractionService().extract({
      title: "Retreat",
      content: "The retreat is in Estonia and includes lodging.",
      metadata: {},
    });

    expect(attributes.locations).toEqual([]);
  });
});
