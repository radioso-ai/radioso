import { describe, expect, it } from "vitest";

import {
  CompositeDocumentAttributeExtractionService,
  SemanticDocumentAttributeExtractionService,
} from "../../src/modules/retrieval/services/documentAttributeExtractionService.js";

describe("document attribute extraction", () => {
  it("builds date ranges from metadata even when the chunk text is sparse", async () => {
    const service = new CompositeDocumentAttributeExtractionService();

    const result = await service.extract({
      title: "Corso Residenziale Benvenuto Ad Ananda",
      content: "# Corso Residenziale Benvenuto Ad Ananda\n\nFonte: https://corsi.ananda.it/...",
      metadata: {
        dateFrom: "2026-05-01",
        dateTo: "2026-05-03",
      },
    });

    expect(result.dateRanges).toEqual([
      {
        start: "2026-05-01",
        end: "2026-05-03",
        confidence: 1,
        sourceText: "metadata.dateFrom/dateTo",
      },
    ]);
  });

  it("extracts prose attributes through the semantic gateway", async () => {
    const service = new CompositeDocumentAttributeExtractionService(
      undefined,
      new SemanticDocumentAttributeExtractionService({
        async extract() {
          return {
            datePoints: [],
            dateRanges: [],
            moneyValues: [],
            locations: [{ value: "Estonia", sourceText: "in Estonia" }],
          };
        },
      }),
    );

    const result = await service.extract({
      title: "Retreat",
      content: "The retreat is in Estonia and includes lodging.",
      metadata: {},
    });

    expect(result.locations).toEqual([
      {
        matchKey: "estonia",
        displayName: "Estonia",
        confidence: 0.95,
        sourceText: "in Estonia",
      },
    ]);
  });
});
