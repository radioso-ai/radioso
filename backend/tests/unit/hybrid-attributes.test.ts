import { describe, expect, it } from "vitest";

import { extractRawStructuredAttributes } from "../../src/modules/retrieval/services/structuredAttributeExtractor.js";
import { normalizeStructuredAttributes } from "../../src/modules/retrieval/services/attributeNormalizer.js";

describe("hybrid attributes", () => {
  it("extracts and normalizes supported structured attributes from chunk text", () => {
    const raw = extractRawStructuredAttributes(
      "Retreat dates: 2026-06-12 to 2026-06-15. Price: 290 EUR. Location: Estonia. Bonus date 2026-07-01.",
    );

    const normalized = normalizeStructuredAttributes(raw);

    expect(normalized.dateRanges).toEqual([
      {
        start: "2026-06-12",
        end: "2026-06-15",
        confidence: 0.95,
        sourceText: "2026-06-12 to 2026-06-15",
      },
    ]);
    expect(normalized.datePoints).toContainEqual({
      value: "2026-07-01",
      granularity: "day",
      confidence: 0.95,
      sourceText: "2026-07-01",
    });
    expect(normalized.moneyValues).toEqual([
      {
        amount: 290,
        currencyCode: "EUR",
        confidence: 0.95,
        sourceText: "290 EUR",
      },
    ]);
    expect(normalized.locations).toEqual([
      {
        matchKey: "estonia",
        displayName: "Estonia",
        confidence: 0.95,
        sourceText: "Estonia",
      },
    ]);
  });

  it("extracts locations from ordinary prose", () => {
    const raw = extractRawStructuredAttributes("The retreat is in Estonia and includes lodging.");
    const normalized = normalizeStructuredAttributes(raw);

    expect(normalized.locations).toEqual([
      {
        matchKey: "estonia",
        displayName: "Estonia",
        confidence: 0.95,
        sourceText: "Estonia",
      },
    ]);
  });
});
