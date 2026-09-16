import { describe, expect, it } from "vitest";

import { mapAnswerCoverageRow, type AnswerCoverageRow } from "../../../src/db/repositories/answerCoverageRowMapper.js";

const baseRow = (overrides: Partial<AnswerCoverageRow> = {}): AnswerCoverageRow => ({
  id: "assessment_1",
  workspace_id: "workspace_1",
  conversation_id: "conversation_1",
  request_message_id: "message_1",
  originating_turn_id: "turn_1",
  contextualized_request: "Where is my order?",
  assistant_message_id: null,
  availability: "assessed",
  coverage: "answered",
  reason: "sufficient_evidence",
  unresolved_request: null,
  schema_version: 1,
  producer: null,
  interaction_evaluation_state: null,
  assessed_at: new Date("2026-05-01T00:00:00.000Z"),
  created_at: new Date("2026-05-01T00:00:00.000Z"),
  ...overrides,
});

describe("mapAnswerCoverageRow (#1260 F4)", () => {
  it("round-trips the producer on a non-assessed (e.g. invalid) row instead of dropping it", () => {
    const row = baseRow({
      availability: "invalid",
      coverage: null,
      reason: null,
      producer: "answer_head",
    });

    const record = mapAnswerCoverageRow(row);

    expect(record).toMatchObject({ availability: "invalid", producer: "answer_head" });
  });

  it("omits producer on a non-assessed row when the column is null", () => {
    const row = baseRow({
      availability: "not_recorded",
      coverage: null,
      reason: null,
      producer: null,
    });

    const record = mapAnswerCoverageRow(row);

    expect(record).not.toHaveProperty("producer");
  });

  it("defaults a legacy assessed row with a null producer column to the pre-#1260 assessor (F14)", () => {
    const row = baseRow({ availability: "assessed", producer: null });

    const record = mapAnswerCoverageRow(row);

    expect(record).toMatchObject({ availability: "assessed", producer: "assessor" });
  });

  it("preserves the head as producer on an assessed row written after #1260", () => {
    const row = baseRow({ availability: "assessed", producer: "answer_head" });

    const record = mapAnswerCoverageRow(row);

    expect(record).toMatchObject({ availability: "assessed", producer: "answer_head" });
  });
});
