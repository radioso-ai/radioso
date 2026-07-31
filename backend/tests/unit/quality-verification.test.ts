import { describe, expect, it } from "vitest";

import type {
  QualityVerification,
  QualityVerificationSourcePort,
} from "../../src/modules/quality/contracts/index.js";
import { QualityTurnsService } from "../../src/modules/quality/service.js";
import { stubOutcomeCatalog } from "../support/qualityOutcomeCatalog.js";

class SequencedDb {
  constructor(private readonly rowSets: unknown[][]) {}

  async executeQuery() {
    return { rows: this.rowSets.shift() ?? [] };
  }
}

class CapturingVerificationSource implements QualityVerificationSourcePort {
  readonly calls: Array<{ workspaceId: string; assistantMessageIds: string[] }> = [];

  constructor(private readonly values: ReadonlyMap<string, QualityVerification>) {}

  async getByAssistantMessageIds(workspaceId: string, assistantMessageIds: string[]) {
    this.calls.push({ workspaceId, assistantMessageIds });
    return this.values;
  }
}

describe("Quality verification enrichment", () => {
  it("loads one batch for the page and maps linked and unlinked turns", async () => {
    const workspaceId = "11111111-1111-1111-1111-111111111111";
    const linkedId = "22222222-2222-2222-2222-222222222222";
    const unlinkedId = "33333333-3333-3333-3333-333333333333";
    const baseRow = {
      conversation_id: "44444444-4444-4444-4444-444444444444",
      agent_id: null,
      agent_name: null,
      source_channel: "embed",
      answer_content: "Answer",
      skill_name: "retrieval.answer",
      skill_outcome: "no_context",
      skill_status: "completed",
      total_latency_ms: null,
      user_question: null,
      up_count: "0",
      down_count: "0",
      latest_down_updated_at: null,
      created_at: "2026-07-30T10:00:00.000Z",
      grounding_verdict: null,
      grounding_claim_count: null,
      grounding_sourced_claim_count: null,
      grounding_unsourced_claim_count: null,
      grounding_invalid_source_count: null,
      triage_state: "open",
      triage_version: 0,
      triage_resolution_reason: null,
      triage_resolution_note: null,
      triage_legacy_reason: null,
      triage_closed_at: null,
      triage_updated_at: null,
    };
    const db = new SequencedDb([
      [{ total: "2" }],
      [
        { ...baseRow, assistant_message_id: linkedId },
        { ...baseRow, assistant_message_id: unlinkedId },
      ],
      [],
    ]);
    const verification: QualityVerification = {
      caseId: "55555555-5555-5555-5555-555555555555",
      caseStatus: "passing",
      latestRunStatus: "pass",
      latestRunAt: "2026-07-30T09:00:00.000Z",
    };
    const source = new CapturingVerificationSource(new Map([[linkedId, verification]]));
    const service = new QualityTurnsService(
      db as never,
      stubOutcomeCatalog(),
      undefined,
      source,
    );

    const page = await service.listLowQualityTurns(workspaceId, { limit: 25 });

    expect(source.calls).toEqual([{
      workspaceId,
      assistantMessageIds: [linkedId, unlinkedId],
    }]);
    expect(page.items[0]?.verification).toEqual(verification);
    expect(page.items[1]?.verification).toBeNull();
  });
});
