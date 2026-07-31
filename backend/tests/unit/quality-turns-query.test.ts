import { describe, expect, it } from "vitest";

import { QualityTurnsService } from "../../src/modules/quality/service.js";
import { stubOutcomeCatalog } from "../support/qualityOutcomeCatalog.js";

class CapturingDb {
  readonly queries: Array<{ sql: string; parameters: readonly unknown[] }> = [];

  constructor(private readonly rowSets: unknown[][]) {}

  async executeQuery(query: { sql: string; parameters: readonly unknown[] }) {
    this.queries.push(query);
    return { rows: this.rowSets.shift() ?? [] };
  }
}

describe("QualityTurnsService list query", () => {
  it("does not bind a comment feedback value when hasComment is omitted", async () => {
    const db = new CapturingDb([[{ total: "0" }], []]);
    const service = new QualityTurnsService(db as never, stubOutcomeCatalog());

    await service.listLowQualityTurns("11111111-1111-1111-1111-111111111111", {
      feedbackValues: ["down"],
      limit: 25,
    });

    expect(db.queries).toHaveLength(2);
    for (const query of db.queries) {
      const parameterIndexes = [...query.sql.matchAll(/\$(\d+)/g)]
        .map((match) => Number(match[1]));
      expect(Math.max(...parameterIndexes)).toBe(query.parameters.length);
    }
  });

  it.each([true, false])(
    "correlates hasComment=%s with the selected feedback value",
    async (hasComment) => {
      const db = new CapturingDb([[{ total: "0" }], []]);
      const service = new QualityTurnsService(db as never, stubOutcomeCatalog());

      await service.listLowQualityTurns("11111111-1111-1111-1111-111111111111", {
        feedbackValues: ["down"],
        hasComment,
        limit: 25,
      });

      expect(db.queries).toHaveLength(2);
      for (const query of db.queries) {
        expect(query.sql).toMatch(
          /f\.comment IS NOT NULL\s+AND f\.value = ANY\(\$\d+::text\[\]\)/,
        );
      }
    },
  );
});
