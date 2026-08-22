import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Database } from "../../src/shared/infra/database.js";
import { QualityTurnsService } from "../../src/modules/quality/service.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";
import { stubOutcomeCatalog } from "../support/qualityOutcomeCatalog.js";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const canReachIntegrationDatabase = async (databaseUrl?: string): Promise<boolean> => {
  if (!databaseUrl) {
    return false;
  }
  const database = new Database(databaseUrl);
  try {
    await database.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await database.close().catch(() => undefined);
  }
};

const hasReachableIntegrationDatabase = await canReachIntegrationDatabase(integrationDatabaseUrl);
const describeIfDatabase = hasReachableIntegrationDatabase ? describe : describe.skip;

// Frozen "now" so the window maths is deterministic. Every fixture timestamp below is
// placed relative to this instant.
const NOW = new Date("2026-07-28T12:00:00.000Z");
const clock = () => NOW;

/** A timestamp `daysAgo` UTC days before today, at midday so it never straddles a bucket. */
const daysAgo = (days: number): string =>
  new Date(Date.UTC(2026, 6, 28 - days, 12, 0, 0)).toISOString();

describeIfDatabase("quality stats integration", () => {
  let database: Database;

  const createService = () =>
    new QualityTurnsService(database.kysely, stubOutcomeCatalog(), clock);

  const seedWorkspace = async (label: string) => {
    const accountId = randomUUID();
    const workspaceId = randomUUID();
    const agentId = randomUUID();

    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [accountId, `${label} Account`, `${label}-${accountId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [workspaceId, accountId, `${label} WS`, `${label.slice(0, 2)}-${workspaceId.slice(0, 8)}`],
    );
    await database.query(
      `INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, $3)`,
      [agentId, workspaceId, `${label} Bot`],
    );

    return { accountId, workspaceId, agentId };
  };

  const seedConversation = async (
    workspaceId: string,
    agentId: string | null,
    sourceChannel: string | null,
  ) => {
    const conversationId = randomUUID();
    await database.query(
      `INSERT INTO conversations (id, workspace_id, agent_id, source_channel) VALUES ($1, $2, $3, $4)`,
      [conversationId, workspaceId, agentId, sourceChannel],
    );
    return conversationId;
  };

  const seedTurn = async (input: {
    conversationId: string;
    workspaceId: string;
    createdAt: string;
    skillName?: string | null;
    skillOutcome?: string | null;
    skillStatus?: string | null;
    totalLatencyMs?: number | null;
    source?: string | null;
  }) => {
    const messageId = randomUUID();
    await database.query(
      `INSERT INTO messages
         (id, conversation_id, workspace_id, role, content, skill_name, skill_outcome, skill_status, total_latency_ms, source, created_at)
       VALUES ($1, $2, $3, 'assistant', 'Answer', $4, $5, $6, $7, $8, $9)`,
      [
        messageId,
        input.conversationId,
        input.workspaceId,
        input.skillName ?? "retrieval.answer",
        input.skillOutcome ?? "grounded",
        input.skillStatus ?? "completed",
        input.totalLatencyMs ?? null,
        input.source ?? null,
        input.createdAt,
      ],
    );
    return messageId;
  };

  const seedFeedback = async (input: {
    workspaceId: string;
    conversationId: string;
    assistantMessageId: string;
    value: "up" | "down";
  }) => {
    await database.query(
      `INSERT INTO assistant_answer_feedback
         (id, workspace_id, conversation_id, assistant_message_id, actor_type, actor_id, value)
       VALUES ($1, $2, $3, $4, 'authenticated_user', $5, $6)`,
      [
        randomUUID(),
        input.workspaceId,
        input.conversationId,
        input.assistantMessageId,
        `user-${randomUUID()}`,
        input.value,
      ],
    );
  };

  beforeAll(async () => {
    database = new Database(integrationDatabaseUrl!);
    await runAllTestMigrations(database);
  });

  afterAll(async () => {
    await database.close();
  });

  it("reports rates over honest denominators and zero-fills empty days", async () => {
    const { workspaceId, agentId } = await seedWorkspace("Rates");
    const conversationId = await seedConversation(workspaceId, agentId, "embed");

    // Day -2: two grounded, one gap, one clarification (grounded-neutral), one failure.
    const grounded = await seedTurn({ conversationId, workspaceId, createdAt: daysAgo(2) });
    await seedTurn({ conversationId, workspaceId, createdAt: daysAgo(2) });
    await seedTurn({ conversationId, workspaceId, createdAt: daysAgo(2), skillOutcome: "no_context" });
    await seedTurn({
      conversationId,
      workspaceId,
      createdAt: daysAgo(2),
      skillOutcome: "clarification_needed",
    });
    await seedTurn({
      conversationId,
      workspaceId,
      createdAt: daysAgo(2),
      skillOutcome: "no_context",
      skillStatus: "failed",
    });

    await seedFeedback({ workspaceId, conversationId, assistantMessageId: grounded, value: "down" });

    const stats = await createService().getQualityStats(workspaceId, { range: "7d" });

    expect(stats.range).toBe("7d");
    expect(stats.current.turnCount).toBe(5);
    // Grounded rate is defined only over turns that attempted to ground: 2 grounded, 2
    // gaps. The clarification turn is in neither, so it never touches the denominator.
    expect(stats.current.grounded).toEqual({ count: 2, denominator: 4, rate: 0.5 });
    expect(stats.current.negativeFeedback).toEqual({ count: 1, denominator: 1, rate: 1 });
    expect(stats.current.skillFailures).toEqual({ count: 1, denominator: 5, rate: 0.2 });

    expect(stats.buckets).toHaveLength(7);
    const active = stats.buckets.find((bucket) => bucket.date === daysAgo(2).slice(0, 10));
    expect(active?.turnCount).toBe(5);
    const quiet = stats.buckets.find((bucket) => bucket.date === daysAgo(4).slice(0, 10));
    expect(quiet).toEqual({
      date: daysAgo(4).slice(0, 10),
      turnCount: 0,
      grounded: { count: 0, denominator: 0, rate: null },
      negativeFeedback: { count: 0, denominator: 0, rate: null },
      skillFailures: { count: 0, denominator: 0, rate: null },
    });
  });

  it("reports a null rate rather than NaN when nothing qualifies", async () => {
    const { workspaceId } = await seedWorkspace("Empty");

    const stats = await createService().getQualityStats(workspaceId, { range: "30d" });

    expect(stats.current.turnCount).toBe(0);
    expect(stats.current.grounded.rate).toBeNull();
    expect(stats.current.negativeFeedback.rate).toBeNull();
    expect(stats.current.skillFailures.rate).toBeNull();
    expect(stats.previous.grounded.rate).toBeNull();
    expect(stats.buckets).toHaveLength(30);
    expect(stats.buckets.every((bucket) => bucket.turnCount === 0)).toBe(true);
    expect(stats.backlog).toEqual({
      negative_feedback: 0,
      grounding_gaps: 0,
      skill_failures: 0,
    });
  });

  it("compares against the equal-length window immediately before the current one", async () => {
    const { workspaceId, agentId } = await seedWorkspace("Compare");
    const conversationId = await seedConversation(workspaceId, agentId, "embed");

    // Current 7d window: days 0..6 ago. Previous: days 7..13 ago.
    await seedTurn({ conversationId, workspaceId, createdAt: daysAgo(1) });
    await seedTurn({ conversationId, workspaceId, createdAt: daysAgo(3) });
    await seedTurn({ conversationId, workspaceId, createdAt: daysAgo(8), skillOutcome: "no_context" });
    // Outside both windows entirely.
    await seedTurn({ conversationId, workspaceId, createdAt: daysAgo(40) });

    const stats = await createService().getQualityStats(workspaceId, { range: "7d" });

    expect(stats.current.turnCount).toBe(2);
    expect(stats.previous.turnCount).toBe(1);
    expect(stats.previous.to).toBe(stats.current.from);
    expect(stats.current.grounded.rate).toBe(1);
    expect(stats.previous.grounded).toEqual({ count: 0, denominator: 1, rate: 0 });
  });

  it("counts a turn with several down-votes once", async () => {
    const { workspaceId, agentId } = await seedWorkspace("Votes");
    const conversationId = await seedConversation(workspaceId, agentId, "embed");
    const messageId = await seedTurn({ conversationId, workspaceId, createdAt: daysAgo(1) });

    await seedFeedback({ workspaceId, conversationId, assistantMessageId: messageId, value: "down" });
    await seedFeedback({ workspaceId, conversationId, assistantMessageId: messageId, value: "down" });
    await seedFeedback({ workspaceId, conversationId, assistantMessageId: messageId, value: "down" });

    const stats = await createService().getQualityStats(workspaceId, { range: "7d" });

    expect(stats.current.turnCount).toBe(1);
    expect(stats.current.negativeFeedback).toEqual({ count: 1, denominator: 1, rate: 1 });
    expect(stats.backlog.negative_feedback).toBe(1);
  });

  it("scopes to the workspace and honours agent and channel filters", async () => {
    const { workspaceId, agentId } = await seedWorkspace("Scope");
    const other = await seedWorkspace("Other");

    const embedConversation = await seedConversation(workspaceId, agentId, "embed");
    const widgetConversation = await seedConversation(workspaceId, agentId, "widget");
    const secondAgentId = randomUUID();
    await database.query(`INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, $3)`, [
      secondAgentId,
      workspaceId,
      "Second Bot",
    ]);
    const secondAgentConversation = await seedConversation(workspaceId, secondAgentId, "embed");

    await seedTurn({ conversationId: embedConversation, workspaceId, createdAt: daysAgo(1) });
    await seedTurn({ conversationId: widgetConversation, workspaceId, createdAt: daysAgo(1) });
    await seedTurn({ conversationId: secondAgentConversation, workspaceId, createdAt: daysAgo(1) });

    const foreignConversation = await seedConversation(other.workspaceId, other.agentId, "embed");
    await seedTurn({
      conversationId: foreignConversation,
      workspaceId: other.workspaceId,
      createdAt: daysAgo(1),
    });

    const service = createService();

    expect((await service.getQualityStats(workspaceId, { range: "7d" })).current.turnCount).toBe(3);
    expect(
      (await service.getQualityStats(workspaceId, { range: "7d", agentId })).current.turnCount,
    ).toBe(2);
    expect(
      (await service.getQualityStats(workspaceId, { range: "7d", channel: "embed" })).current.turnCount,
    ).toBe(2);
    expect(
      (await service.getQualityStats(workspaceId, { range: "7d", agentId, channel: "embed" }))
        .current.turnCount,
    ).toBe(1);

    const filtered = await service.getQualityStats(workspaceId, {
      range: "7d",
      agentId,
      channel: "embed",
    });
    expect(filtered.filters).toEqual({ agentId, channel: "embed" });
  });

  it("excludes operator-test channels while keeping null-source conversations", async () => {
    const { workspaceId, agentId } = await seedWorkspace("OpTest");

    const embed = await seedConversation(workspaceId, agentId, "embed");
    const nullSource = await seedConversation(workspaceId, agentId, null);
    const testChat = await seedConversation(workspaceId, agentId, "authenticated_chat");
    const replay = await seedConversation(workspaceId, agentId, "workbench_replay");
    const rayProbe = await seedConversation(workspaceId, agentId, "operator_copilot_probe");

    for (const conversationId of [embed, nullSource, testChat, replay, rayProbe]) {
      await seedTurn({ conversationId, workspaceId, createdAt: daysAgo(1) });
    }

    const stats = await createService().getQualityStats(workspaceId, { range: "7d" });

    expect(stats.current.turnCount).toBe(2);
  });

  it("excludes human-authored replies from the AI turn population", async () => {
    const { workspaceId, agentId } = await seedWorkspace("Handoff");
    const conversationId = await seedConversation(workspaceId, agentId, "embed");

    // An AI turn, plus two operator takeover replies. Both are stored with
    // role='assistant' but a human source, and carry no skill outcome or latency.
    await seedTurn({ conversationId, workspaceId, createdAt: daysAgo(1), source: "ai_agent" });
    await seedTurn({
      conversationId,
      workspaceId,
      createdAt: daysAgo(1),
      source: "human_agent",
      skillName: null,
      skillOutcome: null,
      skillStatus: null,
    });
    await seedTurn({
      conversationId,
      workspaceId,
      createdAt: daysAgo(1),
      source: "human_agent_on_behalf_of_ai_agent",
      skillName: null,
      skillOutcome: null,
      skillStatus: null,
    });
    // Predates the `source` column: NULL must still count as an AI turn.
    await seedTurn({ conversationId, workspaceId, createdAt: daysAgo(1), source: null });

    const stats = await createService().getQualityStats(workspaceId, { range: "7d" });

    expect(stats.current.turnCount).toBe(2);
    expect(stats.current.grounded).toEqual({ count: 2, denominator: 2, rate: 1 });

    // The table must select from the same population, or a chip count and the rows
    // behind it would disagree.
    const page = await createService().listLowQualityTurns(workspaceId, { limit: 25 });
    expect(page.total).toBe(2);
  });

  it("counts an all-time active-triage backlog that ignores the health window", async () => {
    const { workspaceId, agentId } = await seedWorkspace("Backlog");
    const conversationId = await seedConversation(workspaceId, agentId, "embed");

    // Far outside any window: still backlog.
    const oldGap = await seedTurn({
      conversationId,
      workspaceId,
      createdAt: daysAgo(200),
      skillOutcome: "no_context",
    });
    const oldFailure = await seedTurn({
      conversationId,
      workspaceId,
      createdAt: daysAgo(150),
      skillStatus: "failed",
    });
    const oldDownVoted = await seedTurn({ conversationId, workspaceId, createdAt: daysAgo(120) });
    await seedFeedback({
      workspaceId,
      conversationId,
      assistantMessageId: oldDownVoted,
      value: "down",
    });

    // A fast turn and a resolved gap: neither is backlog.
    await seedTurn({ conversationId, workspaceId, createdAt: daysAgo(1), totalLatencyMs: 400 });
    const resolvedGap = await seedTurn({
      conversationId,
      workspaceId,
      createdAt: daysAgo(1),
      skillOutcome: "degraded",
    });

    const service = createService();
    await service.setTriageState(workspaceId, {
      assistantMessageId: resolvedGap,
      state: "resolved",
      expectedVersion: 0,
      resolution: { reason: "knowledge_gap", note: null },
    });

    const stats = await service.getQualityStats(workspaceId, { range: "7d" });

    // The 7d window sees only the two recent turns...
    expect(stats.current.turnCount).toBe(2);
    // ...while the backlog reaches back over everything still untriaged.
    expect(stats.backlog).toEqual({
      negative_feedback: 1,
      grounding_gaps: 1,
      skill_failures: 1,
    });
    expect([oldGap, oldFailure, oldDownVoted]).toHaveLength(3);

    // Acknowledged turns are still active backlog; dismissing one drains it.
    await service.setTriageState(workspaceId, {
      assistantMessageId: oldGap,
      state: "acknowledged",
      expectedVersion: 0,
    });
    expect((await service.getQualityStats(workspaceId, { range: "7d" })).backlog.grounding_gaps).toBe(1);

    await service.setTriageState(workspaceId, {
      assistantMessageId: oldGap,
      state: "dismissed",
      expectedVersion: 1,
      resolution: { reason: "expected_behavior", note: null },
    });
    expect((await service.getQualityStats(workspaceId, { range: "7d" })).backlog.grounding_gaps).toBe(0);
  });

  it("resolves latency from the audit event when the column is empty", async () => {
    const { accountId, workspaceId, agentId } = await seedWorkspace("LegacySlow");
    const conversationId = await seedConversation(workspaceId, agentId, "embed");
    const legacyMessageId = await seedTurn({
      conversationId,
      workspaceId,
      createdAt: daysAgo(3),
      totalLatencyMs: null,
    });

    await database.query(
      `INSERT INTO audit_events (id, account_id, workspace_id, event_type, event_status, metadata_json)
       VALUES ($1, $2, $3, 'chat.answer', 'success', $4::jsonb)`,
      [
        randomUUID(),
        accountId,
        workspaceId,
        JSON.stringify({
          assistantMessageId: legacyMessageId,
          activityTrace: { totalDurationMs: 15_000 },
        }),
      ],
    );

    const page = await createService().listLowQualityTurns(workspaceId, {
      limit: 25,
      minTotalLatencyMs: 10_000,
    });

    expect(page.items.map((item) => item.assistantMessageId)).toEqual([legacyMessageId]);
  });

  it("filters the turns table by the same signal predicate the backlog counts", async () => {
    const { workspaceId, agentId } = await seedWorkspace("Signal");
    const conversationId = await seedConversation(workspaceId, agentId, "embed");

    const gap = await seedTurn({
      conversationId,
      workspaceId,
      createdAt: daysAgo(1),
      skillOutcome: "no_context",
    });
    await seedTurn({ conversationId, workspaceId, createdAt: daysAgo(1) });
    // Omits the grounded flag: neither grounded nor a gap, so the chip must not claim it.
    await seedTurn({
      conversationId,
      workspaceId,
      createdAt: daysAgo(1),
      skillOutcome: "clarification_needed",
    });

    const service = createService();
    const page = await service.listLowQualityTurns(workspaceId, {
      limit: 25,
      signals: ["grounding_gaps"],
      triageStates: ["open", "acknowledged"],
    });

    expect(page.items.map((item) => item.assistantMessageId)).toEqual([gap]);
    expect(page.total).toBe(1);
    expect((await service.getQualityStats(workspaceId, { range: "7d" })).backlog.grounding_gaps).toBe(1);
  });
});
