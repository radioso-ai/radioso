import { describe, expect, it } from "vitest";

import type {
  QualityVerification,
  QualityVerificationSourcePort,
} from "../../src/modules/quality/contracts/index.js";
import {
  QualityContentPlanningEvidenceSource,
  type QualityContentPlanningPopulationCursor,
} from "../../src/modules/quality/contentPlanningEvidence.js";

class CapturingDb {
  readonly queries: Array<{ sql: string; parameters: readonly unknown[] }> = [];

  constructor(private readonly rowSets: unknown[][]) {}

  async executeQuery(query: { sql: string; parameters: readonly unknown[] }) {
    this.queries.push(query);
    return { rows: this.rowSets.shift() ?? [] };
  }
}

class VerificationSource implements QualityVerificationSourcePort {
  readonly calls: Array<{ workspaceId: string; assistantMessageIds: string[] }> = [];

  constructor(private readonly values: ReadonlyMap<string, QualityVerification>) {}

  async getByAssistantMessageIds(workspaceId: string, assistantMessageIds: string[]) {
    this.calls.push({ workspaceId, assistantMessageIds });
    return this.values;
  }
}

const workspaceId = "11111111-1111-1111-1111-111111111111";
const conversationId = "22222222-2222-2222-2222-222222222222";
const agentId = "33333333-3333-3333-3333-333333333333";

const populationRow = (index: number) => ({
  assistant_message_id: `00000000-0000-0000-0000-00000000000${index}`,
  user_message_id: `10000000-0000-0000-0000-00000000000${index}`,
  conversation_id: conversationId,
  agent_id: agentId,
  source_channel: "embed",
  created_at: `2026-07-0${index}T10:00:00.000Z`,
});

const evidenceRow = (overrides: Record<string, unknown>) => ({
  assistant_message_id: "00000000-0000-0000-0000-000000000001",
  conversation_id: conversationId,
  agent_id: agentId,
  source_channel: "embed",
  created_at: "2026-07-01T10:00:00.000Z",
  grounding_verdict: "no_support",
  grounding_claim_count: 1,
  grounding_sourced_claim_count: 0,
  grounding_unsourced_claim_count: 1,
  grounding_invalid_source_count: 0,
  triage_state: "open",
  triage_resolution_reason: null,
  triage_reopened_by_feedback: false,
  ...overrides,
});

describe("QualityContentPlanningEvidenceSource", () => {
  it("pages the canonical population with a frozen stable cursor and no message content", async () => {
    const db = new CapturingDb([[
      populationRow(1),
      populationRow(2),
      populationRow(3),
    ]]);
    const source = new QualityContentPlanningEvidenceSource(db as never);

    const page = await source.listPopulationPage(workspaceId, {
      window: {
        from: "2026-07-01T00:00:00.000Z",
        to: "2026-08-01T00:00:00.000Z",
      },
      limit: 2,
    });

    expect(page.items).toEqual([
      {
        assistantMessageId: "00000000-0000-0000-0000-000000000001",
        userMessageId: "10000000-0000-0000-0000-000000000001",
        conversationId,
        agentId,
        channel: "embed",
        createdAt: "2026-07-01T10:00:00.000Z",
      },
      {
        assistantMessageId: "00000000-0000-0000-0000-000000000002",
        userMessageId: "10000000-0000-0000-0000-000000000002",
        conversationId,
        agentId,
        channel: "embed",
        createdAt: "2026-07-02T10:00:00.000Z",
      },
    ]);
    expect(page.nextCursor).toEqual({
      createdAt: "2026-07-02T10:00:00.000Z",
      assistantMessageId: "00000000-0000-0000-0000-000000000002",
      windowFrom: "2026-07-01T00:00:00.000Z",
      windowTo: "2026-08-01T00:00:00.000Z",
    });
    expect(JSON.stringify(page)).not.toContain("content");

    const query = db.queries[0]!;
    expect(query.sql).toContain("m.role = 'assistant'");
    expect(query.sql).toContain("c.source_channel IS NULL OR c.source_channel NOT IN");
    expect(query.sql).toContain("m.source IS NULL OR m.source NOT IN");
    expect(query.sql).toContain("ORDER BY m.created_at ASC, m.id ASC");
    expect(query.sql).not.toContain("m.content");
    expect(query.parameters).toContain("2026-08-01T00:00:00.000Z");
  });

  it("uses cursor keys only inside the same frozen window", async () => {
    const db = new CapturingDb([[]]);
    const source = new QualityContentPlanningEvidenceSource(db as never);
    const cursor: QualityContentPlanningPopulationCursor = {
      createdAt: "2026-07-15T12:00:00.000Z",
      assistantMessageId: "00000000-0000-0000-0000-000000000099",
      windowFrom: "2026-07-01T00:00:00.000Z",
      windowTo: "2026-08-01T00:00:00.000Z",
    };

    await source.listPopulationPage(workspaceId, {
      window: { from: cursor.windowFrom, to: cursor.windowTo },
      cursor,
      limit: 25,
    });

    expect(db.queries[0]?.sql).toMatch(/m\.created_at > \$\d+::timestamptz/);
    expect(db.queries[0]?.sql).toMatch(/m\.created_at = \$\d+::timestamptz AND m\.id > \$\d+::uuid/);

    await expect(source.listPopulationPage(workspaceId, {
      window: { from: cursor.windowFrom, to: "2026-08-02T00:00:00.000Z" },
      cursor,
      limit: 25,
    })).rejects.toThrow("population cursor window does not match the requested window");
  });

  it("hydrates grounding, effective triage, and Eval evidence without raw content", async () => {
    const openGapId = "00000000-0000-0000-0000-000000000001";
    const passingGapId = "00000000-0000-0000-0000-000000000002";
    const dismissedGapId = "00000000-0000-0000-0000-000000000003";
    const groundedId = "00000000-0000-0000-0000-000000000004";
    const unevaluatedId = "00000000-0000-0000-0000-000000000005";
    const excludedId = "00000000-0000-0000-0000-000000000006";
    const db = new CapturingDb([[
      evidenceRow({
        assistant_message_id: openGapId,
        triage_state: "open",
        triage_reopened_by_feedback: true,
      }),
      evidenceRow({
        assistant_message_id: passingGapId,
        grounding_verdict: "degraded",
        grounding_claim_count: 2,
        grounding_sourced_claim_count: 1,
        grounding_unsourced_claim_count: 1,
        triage_state: "acknowledged",
      }),
      evidenceRow({
        assistant_message_id: dismissedGapId,
        triage_state: "dismissed",
        triage_resolution_reason: "out_of_scope",
      }),
      evidenceRow({
        assistant_message_id: groundedId,
        grounding_verdict: "grounded",
        grounding_claim_count: 2,
        grounding_sourced_claim_count: 2,
        grounding_unsourced_claim_count: 0,
      }),
      evidenceRow({
        assistant_message_id: unevaluatedId,
        grounding_verdict: null,
        grounding_claim_count: null,
        grounding_sourced_claim_count: null,
        grounding_unsourced_claim_count: null,
        grounding_invalid_source_count: null,
      }),
    ]]);
    const passing: QualityVerification = {
      caseId: "44444444-4444-4444-4444-444444444444",
      caseStatus: "passing",
      latestRunStatus: "pass",
      latestRunAt: "2026-07-30T09:00:00.000Z",
    };
    const verificationSource = new VerificationSource(new Map([[passingGapId, passing]]));
    const source = new QualityContentPlanningEvidenceSource(db as never, verificationSource);

    const evidence = await source.getEvidenceByAssistantMessageIds(workspaceId, [
      openGapId,
      passingGapId,
      dismissedGapId,
      groundedId,
      unevaluatedId,
      excludedId,
      openGapId,
    ]);

    expect([...evidence.keys()]).toEqual([
      openGapId,
      passingGapId,
      dismissedGapId,
      groundedId,
      unevaluatedId,
    ]);
    expect(evidence.get(openGapId)).toMatchObject({
      grounding: { verdict: "no_support", claimCount: 1, sourcedClaimCount: 0, unsourcedClaimCount: 1 },
      triage: { state: "open", resolutionReason: null, reopenedByNewerNegativeFeedback: true },
      remediation: { active: true, inactiveReasons: [] },
    });
    expect(evidence.get(passingGapId)).toMatchObject({
      grounding: { verdict: "degraded" },
      triage: { state: "acknowledged" },
      verification: passing,
      remediation: { active: false, inactiveReasons: ["passing_eval"] },
    });
    expect(evidence.get(dismissedGapId)).toMatchObject({
      triage: { state: "dismissed", resolutionReason: "out_of_scope" },
      remediation: { active: false, inactiveReasons: ["triage_dismissed"] },
    });
    expect(evidence.get(groundedId)?.remediation).toEqual({
      active: false,
      inactiveReasons: ["grounded_answer"],
    });
    expect(evidence.get(unevaluatedId)?.remediation).toEqual({
      active: false,
      inactiveReasons: ["not_evaluated"],
    });
    expect(evidence.has(excludedId)).toBe(false);
    expect(verificationSource.calls).toEqual([{
      workspaceId,
      assistantMessageIds: [openGapId, passingGapId, dismissedGapId, groundedId, unevaluatedId],
    }]);

    const query = db.queries[0]!;
    expect(query.sql).toContain("quality_feedback.latest_down_updated_at > tr.updated_at");
    expect(query.sql).not.toContain("m.content");
    expect(query.sql).not.toContain("resolution_note");
    expect(JSON.stringify([...evidence.values()])).not.toContain("answer_content");
  });

  it("maps a bounded member page through the existing Quality turn representation", async () => {
    const assistantMessageId = "00000000-0000-0000-0000-000000000010";
    const db = new CapturingDb([
      [{
        assistant_message_id: assistantMessageId,
        conversation_id: conversationId,
        agent_id: agentId,
        agent_name: "Support Bot",
        source_channel: "embed",
        answer_content: "A grounded answer",
        skill_name: "retrieval.answer",
        skill_outcome: "grounded",
        skill_status: "completed",
        total_latency_ms: 120,
        user_question: "What is the policy?",
        up_count: "1",
        down_count: "0",
        latest_down_updated_at: null,
        created_at: "2026-07-15T10:00:01.000Z",
        grounding_verdict: "grounded",
        grounding_claim_count: 1,
        grounding_sourced_claim_count: 1,
        grounding_unsourced_claim_count: 0,
        grounding_invalid_source_count: 0,
        triage_state: "open",
        triage_version: 0,
        triage_resolution_reason: null,
        triage_resolution_note: null,
        triage_legacy_reason: null,
        triage_closed_at: null,
        triage_updated_at: null,
      }],
      [{
        assistant_message_id: assistantMessageId,
        value: "up",
        comment: "Helpful",
        created_at: "2026-07-15T10:01:00.000Z",
        updated_at: "2026-07-15T10:01:00.000Z",
      }],
    ]);
    const source = new QualityContentPlanningEvidenceSource(db as never);

    const page = await source.mapMemberTurnPage(workspaceId, {
      assistantMessageIds: [assistantMessageId],
      total: 3,
      page: 2,
      pageSize: 1,
    });

    expect(page).toEqual({
      items: [expect.objectContaining({
        assistantMessageId,
        conversationId,
        question: "What is the policy?",
        answerPreview: "A grounded answer",
        grounding: expect.objectContaining({ verdict: "grounded" }),
        feedback: expect.objectContaining({
          upCount: 1,
          comments: [expect.objectContaining({ comment: "Helpful" })],
        }),
        triage: expect.objectContaining({ state: "open" }),
      })],
      total: 3,
      page: 2,
      pageSize: 1,
      totalPages: 3,
    });
    expect(db.queries[0]?.sql).toContain("array_position");
    expect(db.queries[0]?.sql).toContain("m.role = 'assistant'");
  });
});
