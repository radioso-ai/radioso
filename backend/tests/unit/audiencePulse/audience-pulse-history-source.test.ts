import { describe, expect, it } from "vitest";

import {
  audiencePulseWeekStartUtc,
  classifyAudiencePulseQuestion,
  completeAudiencePulseWeeklyVolume,
  isAudiencePulseCustomerSource,
  isAudiencePulseEndUserChannel,
  type AudiencePulseConversationMessageRow,
  type AudiencePulseEligibleQuestionRow,
} from "../../../src/modules/chat/audiencePulseHistorySource.js";

const question = (overrides: Partial<AudiencePulseEligibleQuestionRow> = {}): AudiencePulseEligibleQuestionRow => ({
  id: "00000000-0000-0000-0000-000000000001",
  conversation_id: "10000000-0000-0000-0000-000000000001",
  content: "How do I update this?",
  created_at: new Date("2026-07-01T12:00:00.000Z"),
  source_channel: null,
  ...overrides,
});

const assistant = (
  overrides: Partial<AudiencePulseConversationMessageRow> = {},
): AudiencePulseConversationMessageRow => ({
  id: "00000000-0000-0000-0000-000000000002",
  conversation_id: "10000000-0000-0000-0000-000000000001",
  role: "assistant",
  source: "ai_agent",
  skill_name: "retrieval.answer",
  skill_outcome: "no_context",
  grounding_verdict: "no_support",
  grounding_claim_count: 1,
  grounding_sourced_claim_count: 0,
  grounding_unsourced_claim_count: 1,
  grounding_invalid_source_count: 0,
  created_at: new Date("2026-07-01T12:00:01.000Z"),
  ...overrides,
});

const userTurn = (item: AudiencePulseEligibleQuestionRow): AudiencePulseConversationMessageRow => ({
  id: item.id,
  conversation_id: item.conversation_id,
  role: "user",
  source: "customer",
  skill_name: null,
  skill_outcome: null,
  grounding_verdict: null,
  grounding_claim_count: null,
  grounding_sourced_claim_count: null,
  grounding_unsourced_claim_count: null,
  grounding_invalid_source_count: null,
  created_at: item.created_at,
});

describe("Audience Pulse history source helpers", () => {
  it("uses UTC Monday calendar weeks and excludes non-visitor sources/channels", () => {
    expect(audiencePulseWeekStartUtc(new Date("2026-08-02T23:59:59.000Z")))
      .toBe("2026-07-27T00:00:00.000Z");
    expect(audiencePulseWeekStartUtc(new Date("2026-08-03T00:00:00.000Z")))
      .toBe("2026-08-03T00:00:00.000Z");

    expect(isAudiencePulseCustomerSource(null)).toBe(true);
    expect(isAudiencePulseCustomerSource("customer")).toBe(true);
    expect(isAudiencePulseCustomerSource("ai_agent")).toBe(false);
    expect(isAudiencePulseEndUserChannel(null)).toBe(true);
    expect(isAudiencePulseEndUserChannel("authenticated_chat")).toBe(false);
    expect(isAudiencePulseEndUserChannel("workbench_replay")).toBe(false);
  });

  it("keeps every UTC week that intersects the analysis period, including zero-volume weeks", () => {
    expect(completeAudiencePulseWeeklyVolume({
      analysisStart: new Date("2026-07-04T00:00:00.000Z"),
      analysisEnd: new Date("2026-08-03T00:00:00.000Z"),
      aggregate: [
        { weekStart: "2026-07-13T00:00:00.000Z", visitorQuestionCount: 4, conversationCount: 3 },
        { weekStart: "2026-07-27T00:00:00.000Z", visitorQuestionCount: 2, conversationCount: 2 },
      ],
    })).toEqual([
      { weekStart: "2026-06-29T00:00:00.000Z", visitorQuestionCount: 0, conversationCount: 0 },
      { weekStart: "2026-07-06T00:00:00.000Z", visitorQuestionCount: 0, conversationCount: 0 },
      { weekStart: "2026-07-13T00:00:00.000Z", visitorQuestionCount: 4, conversationCount: 3 },
      { weekStart: "2026-07-20T00:00:00.000Z", visitorQuestionCount: 0, conversationCount: 0 },
      { weekStart: "2026-07-27T00:00:00.000Z", visitorQuestionCount: 2, conversationCount: 2 },
    ]);
  });

  it("pairs only the first AI assistant answer before the next user turn and classifies typed outcomes", () => {
    const candidate = question();
    expect(classifyAudiencePulseQuestion(candidate, [userTurn(candidate), assistant()])).toEqual({
      grounding: "no_support",
      contentGapEligible: true,
    });

    expect(classifyAudiencePulseQuestion(candidate, [
      userTurn(candidate),
      userTurn({ ...candidate, id: "00000000-0000-0000-0000-000000000003", created_at: new Date("2026-07-01T12:00:00.500Z") }),
      assistant(),
    ])).toEqual({ grounding: "unknown", contentGapEligible: false });

    expect(classifyAudiencePulseQuestion(candidate, [
      userTurn(candidate),
      assistant({ source: "human_agent" }),
    ])).toEqual({ grounding: "unknown", contentGapEligible: false });

    expect(classifyAudiencePulseQuestion(candidate, [
      userTurn(candidate),
      assistant({
        grounding_verdict: null,
        grounding_claim_count: null,
        grounding_sourced_claim_count: null,
        grounding_unsourced_claim_count: null,
        grounding_invalid_source_count: null,
      }),
    ])).toEqual({ grounding: "unknown", contentGapEligible: false });

    expect(classifyAudiencePulseQuestion(candidate, [
      userTurn(candidate),
      assistant({ skill_outcome: "out_of_scope" }),
    ])).toEqual({ grounding: "no_support", contentGapEligible: false });

    expect(classifyAudiencePulseQuestion(candidate, [
      userTurn(candidate),
      assistant({
        skill_outcome: "grounded_degraded",
        grounding_verdict: "degraded",
        grounding_claim_count: 1,
        grounding_sourced_claim_count: 0,
        grounding_unsourced_claim_count: 1,
      }),
    ])).toEqual({ grounding: "degraded", contentGapEligible: true });
  });
});
