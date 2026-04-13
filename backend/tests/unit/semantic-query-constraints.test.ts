import { describe, expect, it } from "vitest";

import { SemanticQueryConstraintService } from "../../src/modules/retrieval/services/semanticQueryConstraintService.js";

describe("semantic query constraints", () => {
  it("normalizes multilingual month queries into date-period constraints", async () => {
    const service = new SemanticQueryConstraintService({
      async interpret() {
        return {
          semanticQuery: "corsi in maggio 2026",
          lexicalQuery: "corsi maggio 2026",
          constraints: [
            {
              signalKey: "document_period",
              operator: "gte",
              confidence: 0.93,
              summary: "from May 2026",
              sourceText: "maggio 2026",
              value: { date: "2026-05-01" },
            },
            {
              signalKey: "document_period",
              operator: "lte",
              confidence: 0.93,
              summary: "until May 2026",
              sourceText: "maggio 2026",
              value: { date: "2026-05-31" },
            },
          ],
        };
      },
    });

    const result = await service.interpret({
      query: "corsi in maggio 2026",
      history: [],
    });

    expect(result.semanticQuery).toBe("corsi in maggio 2026");
    expect(result.lexicalQuery).toBe("corsi maggio 2026");
    expect(result.constraints).toEqual([
      expect.objectContaining({
        signalKey: "document_period",
        operator: "gte",
        value: { date: "2026-05-01" },
        sourceText: "maggio 2026",
      }),
      expect.objectContaining({
        signalKey: "document_period",
        operator: "lte",
        value: { date: "2026-05-31" },
        sourceText: "maggio 2026",
      }),
    ]);
  });
});
