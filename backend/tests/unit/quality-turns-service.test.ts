import type { QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import type { ApplicationDatabasePort } from "../../src/app/composition/applicationModule.js";
import { QualityTurnsService } from "../../src/modules/quality/service.js";

interface CapturedQuery {
  text: string;
  params: unknown[];
}

class CapturingDatabase implements ApplicationDatabasePort {
  readonly queries: CapturedQuery[] = [];

  constructor(private readonly responses: Array<Record<string, unknown>[]>) {}

  async query<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
    this.queries.push({ text, params });
    const next = this.responses.shift() ?? [];
    return next as unknown as T[];
  }
}

const totalRow = (total: number) => [{ total: String(total) }];

describe("QualityTurnsService", () => {
  it("maps turn rows and their comments into LowQualityTurn entries", async () => {
    const database = new CapturingDatabase([
      totalRow(1),
      [
        {
          assistant_message_id: "msg-1",
          conversation_id: "conv-1",
          agent_id: "agent-1",
          agent_name: "Support",
          source_channel: "embed",
          answer_content: "We do not currently support refunds for that plan.",
          answer_outcome: "no_context_refusal",
          user_question: "Can I get a refund?",
          up_count: "0",
          down_count: "2",
          created_at: new Date("2026-05-22T10:00:00.000Z"),
        },
      ],
      [
        {
          assistant_message_id: "msg-1",
          value: "down",
          comment: "Not the answer I needed",
          created_at: new Date("2026-05-22T10:05:00.000Z"),
        },
      ],
    ]);

    const service = new QualityTurnsService(database);
    const page = await service.listLowQualityTurns("workspace-1", { limit: 25 });

    expect(page.items).toEqual([
      {
        assistantMessageId: "msg-1",
        conversationId: "conv-1",
        agentId: "agent-1",
        agentName: "Support",
        channel: "embed",
        question: "Can I get a refund?",
        answerPreview: "We do not currently support refunds for that plan.",
        answerOutcome: "no_context_refusal",
        createdAt: "2026-05-22T10:00:00.000Z",
        feedback: {
          upCount: 0,
          downCount: 2,
          comments: [
            {
              value: "down",
              comment: "Not the answer I needed",
              createdAt: "2026-05-22T10:05:00.000Z",
            },
          ],
        },
      },
    ]);
    expect(page.total).toBe(1);
    expect(page.page).toBe(1);
    expect(page.pageSize).toBe(25);
    expect(page.totalPages).toBe(1);
  });

  it("defaults to surfacing non-grounded outcomes or any feedback when no filters are given", async () => {
    const database = new CapturingDatabase([totalRow(0), [], []]);
    const service = new QualityTurnsService(database);

    await service.listLowQualityTurns("workspace-1", { limit: 10 });

    const [countQuery] = database.queries;
    expect(countQuery?.text).toMatch(/SELECT COUNT/);
    expect(countQuery?.text).toMatch(/m\.answer_outcome IS DISTINCT FROM 'grounded_success'/);
    expect(countQuery?.text).toMatch(/EXISTS \(\s*SELECT 1 FROM assistant_answer_feedback f/);
  });

  it("applies outcome, feedback, agent, channel, and date filters with offset pagination", async () => {
    const database = new CapturingDatabase([totalRow(0), [], []]);
    const service = new QualityTurnsService(database);

    await service.listLowQualityTurns("workspace-1", {
      limit: 10,
      offset: 20,
      outcomes: ["no_context_refusal"],
      feedbackValues: ["down"],
      hasComment: true,
      agentId: "agent-9",
      channel: "embed",
      from: "2026-05-01T00:00:00.000Z",
      to: "2026-05-23T00:00:00.000Z",
    });

    const [, listQuery] = database.queries;
    expect(listQuery?.params).toEqual([
      "workspace-1",
      ["no_context_refusal"],
      ["down"],
      "agent-9",
      "embed",
      "2026-05-01T00:00:00.000Z",
      "2026-05-23T00:00:00.000Z",
      10,
      20,
    ]);
    expect(listQuery?.text).toMatch(/m\.answer_outcome = ANY\(\$2::text\[\]\)/);
    expect(listQuery?.text).toMatch(/f\.value = ANY\(\$3::text\[\]\)/);
    expect(listQuery?.text).toMatch(/c\.agent_id = \$4/);
    expect(listQuery?.text).toMatch(/c\.source_channel = \$5/);
    expect(listQuery?.text).toMatch(/m\.created_at >= \$6::timestamptz/);
    expect(listQuery?.text).toMatch(/m\.created_at <= \$7::timestamptz/);
    expect(listQuery?.text).toMatch(/LIMIT \$8/);
    expect(listQuery?.text).toMatch(/OFFSET \$9/);
  });

  it("computes page numbers from the requested offset", async () => {
    const database = new CapturingDatabase([
      totalRow(100),
      Array.from({ length: 25 }, (_, index) => ({
        assistant_message_id: `msg-${index}`,
        conversation_id: "conv-1",
        agent_id: null,
        agent_name: null,
        source_channel: null,
        answer_content: `Answer ${index}`,
        answer_outcome: "no_context_refusal",
        user_question: `Question ${index}`,
        up_count: "0",
        down_count: "0",
        created_at: new Date(`2026-05-2${index % 10}T10:00:00.000Z`),
      })),
      [],
    ]);

    const service = new QualityTurnsService(database);
    const page = await service.listLowQualityTurns("workspace-1", { limit: 25, offset: 50 });

    expect(page.items).toHaveLength(25);
    expect(page.total).toBe(100);
    expect(page.page).toBe(3);
    expect(page.pageSize).toBe(25);
    expect(page.totalPages).toBe(4);
  });
});
