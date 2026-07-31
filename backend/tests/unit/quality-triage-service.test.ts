import { describe, expect, it } from "vitest";

import { QualityTurnsService } from "../../src/modules/quality/service.js";
import { stubOutcomeCatalog } from "../support/qualityOutcomeCatalog.js";

class SequencedDb {
  readonly queries: Array<{ sql: string; parameters: readonly unknown[] }> = [];

  constructor(private readonly rowSets: unknown[][]) {}

  async executeQuery(query: { sql: string; parameters: readonly unknown[] }) {
    this.queries.push(query);
    return { rows: this.rowSets.shift() ?? [] };
  }
}

describe("QualityTurnsService triage transition", () => {
  it("maps an accepted structured transition and writes audit in the same statement", async () => {
    const db = new SequencedDb([[
      {
        state: "resolved",
        version: 1,
        resolution_reason: "knowledge_gap",
        resolution_note: "Updated policy",
        legacy_reason: null,
        closed_at: "2026-07-30T10:00:00.000Z",
        updated_at: "2026-07-30T10:00:00.000Z",
      },
    ]]);
    const service = new QualityTurnsService(
      db as never,
      stubOutcomeCatalog(),
    );

    const result = await service.setTriageState("11111111-1111-1111-1111-111111111111", {
      assistantMessageId: "22222222-2222-2222-2222-222222222222",
      state: "resolved",
      expectedVersion: 0,
      resolution: { reason: "knowledge_gap", note: "Updated policy" },
      updatedBy: "33333333-3333-3333-3333-333333333333",
    });

    expect(result).toEqual({
      kind: "updated",
      record: {
        state: "resolved",
        version: 1,
        resolution: { reason: "knowledge_gap", note: "Updated policy" },
        legacyReason: null,
        closedAt: "2026-07-30T10:00:00.000Z",
        updatedAt: "2026-07-30T10:00:00.000Z",
      },
    });
    expect(db.queries).toHaveLength(1);
    expect(db.queries[0]?.sql).toContain("INSERT INTO assistant_answer_triage_transitions");
    const auditColumns = db.queries[0]?.sql.match(
      /INSERT INTO assistant_answer_triage_transitions\s*\(([^)]+)\)/,
    )?.[1] ?? "";
    expect(auditColumns).toContain("resolution_reason");
    expect(auditColumns).not.toContain("resolution_note");
  });

  it("loads and returns the current record when the conditional write loses", async () => {
    const db = new SequencedDb([
      [],
      [{
        state: "acknowledged",
        version: 2,
        resolution_reason: null,
        resolution_note: null,
        legacy_reason: null,
        closed_at: null,
        updated_at: "2026-07-30T10:00:00.000Z",
      }],
    ]);
    const service = new QualityTurnsService(db as never, stubOutcomeCatalog());

    const result = await service.setTriageState("11111111-1111-1111-1111-111111111111", {
      assistantMessageId: "22222222-2222-2222-2222-222222222222",
      state: "open",
      expectedVersion: 1,
    });

    expect(result).toEqual({
      kind: "conflict",
      current: {
        state: "acknowledged",
        version: 2,
        resolution: null,
        legacyReason: null,
        closedAt: null,
        updatedAt: "2026-07-30T10:00:00.000Z",
      },
    });
  });
});
