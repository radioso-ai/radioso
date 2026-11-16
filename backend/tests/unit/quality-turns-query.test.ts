import { describe, expect, it } from "vitest";

import { QualityTurnsService } from "../../src/modules/quality/service.js";
import { unrecordedConversationActivity } from "../support/fakes.js";
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
  it.each(["", " \t\n"])(
    "maps an agent's blank internal_name (%j) to null",
    async (internalName) => {
      const db = new CapturingDb([
        [{ total: "1" }],
        [{
          assistant_message_id: "11111111-1111-1111-1111-111111111111",
          conversation_id: "22222222-2222-2222-2222-222222222222",
          agent_id: "33333333-3333-3333-3333-333333333333",
          agent_name: "Support",
          agent_internal_name: internalName,
          source_channel: "dashboard",
          answer_content: "Answer",
          skill_name: null,
          skill_outcome: null,
          skill_status: "completed",
          grounding_verdict: null,
          grounding_claim_count: null,
          grounding_sourced_claim_count: null,
          grounding_unsourced_claim_count: null,
          grounding_invalid_source_count: null,
          total_latency_ms: null,
          user_question: "Question",
          up_count: "0",
          down_count: "0",
          latest_down_updated_at: null,
          created_at: "2026-08-03T00:00:00.000Z",
          triage_state: "open",
          triage_version: 0,
          triage_resolution_reason: null,
          triage_resolution_note: null,
          triage_legacy_reason: null,
          triage_closed_at: null,
          triage_updated_at: null,
        }],
        [],
      ]);
      const service = new QualityTurnsService(db as never, stubOutcomeCatalog(), unrecordedConversationActivity);

      const page = await service.listLowQualityTurns(
        "11111111-1111-1111-1111-111111111111",
        { limit: 25 },
      );

      expect(page.items[0]?.agentInternalName).toBeNull();
    },
  );

  describe("the question a turn answers", () => {
    const READING = "A landscape photo of rolling countryside.";
    const questionRow = (userQuestion: string, userQuestionMetadata: unknown) => ({
      assistant_message_id: "11111111-1111-1111-1111-111111111111",
      conversation_id: "22222222-2222-2222-2222-222222222222",
      agent_id: "33333333-3333-3333-3333-333333333333",
      agent_name: "Support",
      agent_internal_name: null,
      source_channel: "dashboard",
      answer_content: "Answer",
      skill_name: null,
      skill_outcome: null,
      skill_status: "completed",
      grounding_verdict: null,
      grounding_claim_count: null,
      grounding_sourced_claim_count: null,
      grounding_unsourced_claim_count: null,
      grounding_invalid_source_count: null,
      total_latency_ms: null,
      user_question: userQuestion,
      user_question_metadata: userQuestionMetadata,
      up_count: "0",
      down_count: "0",
      latest_down_updated_at: null,
      created_at: "2026-08-03T00:00:00.000Z",
      triage_state: "open",
      triage_version: 0,
      triage_resolution_reason: null,
      triage_resolution_note: null,
      triage_legacy_reason: null,
      triage_closed_at: null,
      triage_updated_at: null,
    });
    const photoMetadata = (typedText: string) => ({
      method: "typed",
      imageInput: { typedText, images: [{ id: "6c3e9f2a-1d4b-4b8e-9f0a-2a4c6e8b0d12", reading: READING }] },
    });
    const listQuestions = async (rows: unknown[]) => {
      const db = new CapturingDb([[{ total: String(rows.length) }], rows, []]);
      const service = new QualityTurnsService(db as never, stubOutcomeCatalog(), unrecordedConversationActivity);
      const page = await service.listLowQualityTurns("11111111-1111-1111-1111-111111111111", { limit: 25 });
      return page.items.map((item) => [item.question, item.questionPhotoCount]);
    };

    it("is what the visitor typed beside photos, with how many photos came with it, never the readings", async () => {
      expect(await listQuestions([
        questionRow(`Something like this\n<attached_photo index="1">${READING}</attached_photo>`, photoMetadata("Something like this")),
        questionRow(`<attached_photo index="1">${READING}</attached_photo>`, photoMetadata("")),
      ])).toEqual([
        ["Something like this", 1],
        [null, 1],
      ]);
    });

    it("is the message whole, with a photo count of zero, when it carried no photos", async () => {
      expect(await listQuestions([
        questionRow("What are your hours?", { method: "typed" }),
        questionRow("What are your hours?", null),
      ])).toEqual([
        ["What are your hours?", 0],
        ["What are your hours?", 0],
      ]);
    });

    it("is null, with a photo count of zero, when no user message came before the answer", async () => {
      expect(await listQuestions([questionRow(null as unknown as string, null)])).toEqual([[null, 0]]);
    });
  });

  it("does not bind a comment feedback value when hasComment is omitted", async () => {
    const db = new CapturingDb([[{ total: "0" }], []]);
    const service = new QualityTurnsService(db as never, stubOutcomeCatalog(), unrecordedConversationActivity);

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
      const service = new QualityTurnsService(db as never, stubOutcomeCatalog(), unrecordedConversationActivity);

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
