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

describeIfDatabase("quality turns integration", () => {
  let database: Database;

  beforeAll(async () => {
    database = new Database(integrationDatabaseUrl!);
    await runAllTestMigrations(database);
  });

  afterAll(async () => {
    await database.close();
  });

  it("surfaces non-grounded refusals and thumbs-down feedback by default", async () => {
    const accountId = randomUUID();
    const workspaceId = randomUUID();
    const agentId = randomUUID();
    const groundedConversationId = randomUUID();
    const refusalConversationId = randomUUID();

    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [accountId, "QA Account", `qa-${accountId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [workspaceId, accountId, "QA Workspace", `qa-${workspaceId.slice(0, 8)}`],
    );
    await database.query(
      `INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, $3)`,
      [agentId, workspaceId, "Support Bot"],
    );

    await database.query(
      `INSERT INTO conversations (id, workspace_id, agent_id, source_channel)
       VALUES ($1, $2, $3, $4)`,
      [groundedConversationId, workspaceId, agentId, "embed"],
    );
    await database.query(
      `INSERT INTO conversations (id, workspace_id, agent_id, source_channel)
       VALUES ($1, $2, $3, $4)`,
      [refusalConversationId, workspaceId, agentId, "embed"],
    );

    const groundedUserMessageId = randomUUID();
    const groundedAssistantMessageId = randomUUID();
    const refusalUserMessageId = randomUUID();
    const refusalAssistantMessageId = randomUUID();

    await database.query(
      `INSERT INTO messages (id, conversation_id, workspace_id, role, content, skill_name, skill_outcome, skill_status, created_at)
       VALUES
         ($1, $2, $3, 'user',      'What is the refund policy?', NULL,               NULL,           NULL,         $4),
         ($5, $2, $3, 'assistant', 'Refunds are processed within 7 days.', 'retrieval.answer', 'grounded',     'completed',  $6),
         ($7, $8, $3, 'user',      'What is the capital of Mars?', NULL,               NULL,           NULL,         $9),
         ($10, $8, $3, 'assistant', 'I do not have information about that.', 'retrieval.answer', 'no_context',   'completed',  $11)`,
      [
        groundedUserMessageId,
        groundedConversationId,
        workspaceId,
        "2026-05-20T09:00:00.000Z",
        groundedAssistantMessageId,
        "2026-05-20T09:00:01.000Z",
        refusalUserMessageId,
        refusalConversationId,
        "2026-05-21T09:00:00.000Z",
        refusalAssistantMessageId,
        "2026-05-21T09:00:01.000Z",
      ],
    );

    await database.query(
      `INSERT INTO assistant_answer_feedback
         (id, workspace_id, conversation_id, assistant_message_id, actor_type, actor_id, value, comment)
       VALUES
         ($1, $2, $3, $4, 'authenticated_user', 'user-1', 'down', 'Did not help')`,
      [randomUUID(), workspaceId, groundedConversationId, groundedAssistantMessageId],
    );

    const service = new QualityTurnsService(database.kysely, stubOutcomeCatalog());
    const page = await service.listLowQualityTurns(workspaceId, { limit: 25 });

    const ids = page.items.map((item) => item.assistantMessageId);
    expect(ids).toContain(refusalAssistantMessageId);
    expect(ids).toContain(groundedAssistantMessageId);

    const refusal = page.items.find((item) => item.assistantMessageId === refusalAssistantMessageId);
    expect(refusal?.skillName).toBe("retrieval.answer");
    expect(refusal?.skillOutcome).toBe("no_context");
    expect(refusal?.question).toBe("What is the capital of Mars?");
    expect(refusal?.agentName).toBe("Support Bot");
    expect(refusal?.channel).toBe("embed");
    expect(refusal?.feedback).toEqual({
      upCount: 0,
      downCount: 0,
      latestDownUpdatedAt: null,
      comments: [],
    });

    const grounded = page.items.find((item) => item.assistantMessageId === groundedAssistantMessageId);
    expect(grounded?.feedback.downCount).toBe(1);
    expect(grounded?.feedback.comments).toEqual([
      expect.objectContaining({ value: "down", comment: "Did not help" }),
    ]);
  });

  it("excludes operator-test conversations (dashboard test chat + workbench replay)", async () => {
    const accountId = randomUUID();
    const workspaceId = randomUUID();
    const agentId = randomUUID();

    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [accountId, "Op Test Account", `optest-${accountId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [workspaceId, accountId, "Op Test WS", `ot-${workspaceId.slice(0, 8)}`],
    );
    await database.query(
      `INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, $3)`,
      [agentId, workspaceId, "Op Test Bot"],
    );

    const embedConversationId = randomUUID();
    const nullSourceConversationId = randomUUID();
    const testChatConversationId = randomUUID();
    const replayConversationId = randomUUID();

    await database.query(
      `INSERT INTO conversations (id, workspace_id, agent_id, source_channel)
       VALUES
         ($1, $5, $6, 'embed'),
         ($2, $5, $6, NULL),
         ($3, $5, $6, 'authenticated_chat'),
         ($4, $5, $6, 'workbench_replay')`,
      [
        embedConversationId,
        nullSourceConversationId,
        testChatConversationId,
        replayConversationId,
        workspaceId,
        agentId,
      ],
    );

    const embedMessageId = randomUUID();
    const nullSourceMessageId = randomUUID();
    const testChatMessageId = randomUUID();
    const replayMessageId = randomUUID();

    await database.query(
      `INSERT INTO messages (id, conversation_id, workspace_id, role, content, skill_name, skill_outcome, skill_status, created_at)
       VALUES
         ($1, $5, $9, 'assistant', 'Embed refusal',     'retrieval.answer', 'no_context', 'completed', $10),
         ($2, $6, $9, 'assistant', 'Null-source refusal','retrieval.answer', 'no_context', 'completed', $11),
         ($3, $7, $9, 'assistant', 'Test-chat refusal', 'retrieval.answer', 'no_context', 'completed', $12),
         ($4, $8, $9, 'assistant', 'Replay refusal',    'retrieval.answer', 'no_context', 'completed', $13)`,
      [
        embedMessageId,
        nullSourceMessageId,
        testChatMessageId,
        replayMessageId,
        embedConversationId,
        nullSourceConversationId,
        testChatConversationId,
        replayConversationId,
        workspaceId,
        "2026-05-24T09:00:00.000Z",
        "2026-05-24T09:00:01.000Z",
        "2026-05-24T09:00:02.000Z",
        "2026-05-24T09:00:03.000Z",
      ],
    );

    const service = new QualityTurnsService(database.kysely, stubOutcomeCatalog());
    const page = await service.listLowQualityTurns(workspaceId, { limit: 25 });

    const ids = page.items.map((item) => item.assistantMessageId);
    expect(ids).toContain(embedMessageId);
    expect(ids).toContain(nullSourceMessageId);
    expect(ids).not.toContain(testChatMessageId);
    expect(ids).not.toContain(replayMessageId);
    // Only the two non-operator-test turns count toward the total.
    expect(page.total).toBe(2);
  });

  it("filters by action tuple and scopes to workspace", async () => {
    const accountId = randomUUID();
    const workspaceA = randomUUID();
    const workspaceB = randomUUID();
    const agentId = randomUUID();

    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [accountId, "Filter Account", `filter-${accountId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [workspaceA, accountId, "WS A", `wa-${workspaceA.slice(0, 8)}`],
    );
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [workspaceB, accountId, "WS B", `wb-${workspaceB.slice(0, 8)}`],
    );
    await database.query(
      `INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, $3)`,
      [agentId, workspaceA, "Filter Bot"],
    );

    const conversationA = randomUUID();
    const conversationB = randomUUID();
    await database.query(
      `INSERT INTO conversations (id, workspace_id, agent_id, source_channel)
       VALUES ($1, $2, $3, 'dashboard')`,
      [conversationA, workspaceA, agentId],
    );
    await database.query(
      `INSERT INTO conversations (id, workspace_id, agent_id, source_channel)
       VALUES ($1, $2, NULL, 'dashboard')`,
      [conversationB, workspaceB],
    );

    const messageInWorkspaceA = randomUUID();
    const messageInWorkspaceB = randomUUID();

    await database.query(
      `INSERT INTO messages (id, conversation_id, workspace_id, role, content, skill_name, skill_outcome, skill_status, created_at)
       VALUES
         ($1, $2, $3, 'assistant', 'A refusal', 'retrieval.answer', 'no_context', 'completed', $4),
         ($5, $6, $7, 'assistant', 'B refusal', 'retrieval.answer', 'no_context', 'completed', $8)`,
      [
        messageInWorkspaceA,
        conversationA,
        workspaceA,
        "2026-05-22T09:00:00.000Z",
        messageInWorkspaceB,
        conversationB,
        workspaceB,
        "2026-05-22T09:00:00.000Z",
      ],
    );

    const service = new QualityTurnsService(database.kysely, stubOutcomeCatalog());
    const page = await service.listLowQualityTurns(workspaceA, {
      limit: 25,
      actions: [{ skillName: "retrieval.answer", outcome: "no_context" }],
    });

    const ids = page.items.map((item) => item.assistantMessageId);
    expect(ids).toContain(messageInWorkspaceA);
    expect(ids).not.toContain(messageInWorkspaceB);
  });

  it("defaults turns to open triage and upserts/filters by triage state", async () => {
    const accountId = randomUUID();
    const workspaceId = randomUUID();
    const userId = randomUUID();
    const conversationId = randomUUID();

    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [accountId, "Triage Account", `triage-${accountId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [workspaceId, accountId, "Triage WS", `tr-${workspaceId.slice(0, 8)}`],
    );
    await database.query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)`,
      [userId, `op-${userId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO conversations (id, workspace_id, source_channel) VALUES ($1, $2, 'dashboard')`,
      [conversationId, workspaceId],
    );

    const openMessageId = randomUUID();
    const resolvedMessageId = randomUUID();
    await database.query(
      `INSERT INTO messages (id, conversation_id, workspace_id, role, content, skill_name, skill_outcome, skill_status, created_at)
       VALUES
         ($1, $2, $3, 'assistant', 'Still open',  'retrieval.answer', 'no_context', 'completed', $4),
         ($5, $2, $3, 'assistant', 'Was resolved', 'retrieval.answer', 'no_context', 'completed', $6)`,
      [
        openMessageId,
        conversationId,
        workspaceId,
        "2026-05-23T09:00:00.000Z",
        resolvedMessageId,
        "2026-05-23T09:01:00.000Z",
      ],
    );

    const service = new QualityTurnsService(database.kysely, stubOutcomeCatalog());

    const initial = await service.listLowQualityTurns(workspaceId, { limit: 25 });
    const openTurn = initial.items.find((item) => item.assistantMessageId === openMessageId);
    expect(openTurn?.triage).toEqual({ state: "open", reason: null, updatedAt: null });

    const updated = await service.setTriageState(workspaceId, {
      assistantMessageId: resolvedMessageId,
      state: "resolved",
      reason: "Added knowledge",
      updatedBy: userId,
    });
    expect(updated?.state).toBe("resolved");
    expect(updated?.reason).toBe("Added knowledge");
    expect(updated?.updatedAt).toEqual(expect.any(String));

    const openOnly = await service.listLowQualityTurns(workspaceId, {
      limit: 25,
      triageStates: ["open"],
    });
    const openIds = openOnly.items.map((item) => item.assistantMessageId);
    expect(openIds).toContain(openMessageId);
    expect(openIds).not.toContain(resolvedMessageId);

    const resolvedOnly = await service.listLowQualityTurns(workspaceId, {
      limit: 25,
      triageStates: ["resolved"],
    });
    const resolvedIds = resolvedOnly.items.map((item) => item.assistantMessageId);
    expect(resolvedIds).toEqual([resolvedMessageId]);
    expect(resolvedOnly.items[0]?.triage.state).toBe("resolved");
  });

  // Latency has two sources: the `messages.total_latency_ms` column new turns write, and
  // the `chat.answer` audit event historical turns only have. The read path must resolve
  // both, so each source gets its own case.
  it("projects and filters latency from the persisted messages column without any audit event", async () => {
    const accountId = randomUUID();
    const workspaceId = randomUUID();
    const agentId = randomUUID();
    const conversationId = randomUUID();

    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [accountId, "Latency Account", `latency-${accountId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [workspaceId, accountId, "Latency WS", `lt-${workspaceId.slice(0, 8)}`],
    );
    await database.query(
      `INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, $3)`,
      [agentId, workspaceId, "Latency Bot"],
    );
    await database.query(
      `INSERT INTO conversations (id, workspace_id, agent_id, source_channel)
       VALUES ($1, $2, $3, 'embed')`,
      [conversationId, workspaceId, agentId],
    );

    const slowMessageId = randomUUID();
    const fastMessageId = randomUUID();
    await database.query(
      `INSERT INTO messages
         (id, conversation_id, workspace_id, role, content, skill_name, skill_outcome, skill_status, total_latency_ms, created_at)
       VALUES
         ($1, $3, $4, 'assistant', 'Slow answer', 'retrieval.answer', 'grounded', 'completed', 8200, $5),
         ($2, $3, $4, 'assistant', 'Fast answer', 'retrieval.answer', 'grounded', 'completed',  310, $6)`,
      [
        slowMessageId,
        fastMessageId,
        conversationId,
        workspaceId,
        "2026-05-25T09:00:00.000Z",
        "2026-05-25T09:00:01.000Z",
      ],
    );

    const service = new QualityTurnsService(database.kysely, stubOutcomeCatalog());

    const all = await service.listLowQualityTurns(workspaceId, { limit: 25 });
    const slow = all.items.find((item) => item.assistantMessageId === slowMessageId);
    expect(slow?.totalLatencyMs).toBe(8200);

    const slowOnly = await service.listLowQualityTurns(workspaceId, {
      limit: 25,
      minTotalLatencyMs: 5000,
    });
    expect(slowOnly.items.map((item) => item.assistantMessageId)).toEqual([slowMessageId]);
    expect(slowOnly.total).toBe(1);

    const fastOnly = await service.listLowQualityTurns(workspaceId, {
      limit: 25,
      maxTotalLatencyMs: 1000,
    });
    expect(fastOnly.items.map((item) => item.assistantMessageId)).toEqual([fastMessageId]);
    expect(fastOnly.total).toBe(1);
  });

  it("falls back to the chat.answer audit event for turns with no persisted latency", async () => {
    const accountId = randomUUID();
    const workspaceId = randomUUID();
    const agentId = randomUUID();
    const conversationId = randomUUID();

    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [accountId, "Legacy Latency Account", `legacy-latency-${accountId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [workspaceId, accountId, "Legacy Latency WS", `ll-${workspaceId.slice(0, 8)}`],
    );
    await database.query(
      `INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, $3)`,
      [agentId, workspaceId, "Legacy Latency Bot"],
    );
    await database.query(
      `INSERT INTO conversations (id, workspace_id, agent_id, source_channel)
       VALUES ($1, $2, $3, 'embed')`,
      [conversationId, workspaceId, agentId],
    );

    const legacyMessageId = randomUUID();
    await database.query(
      `INSERT INTO messages
         (id, conversation_id, workspace_id, role, content, skill_name, skill_outcome, skill_status, created_at)
       VALUES ($1, $2, $3, 'assistant', 'Legacy answer', 'retrieval.answer', 'grounded', 'completed', $4)`,
      [legacyMessageId, conversationId, workspaceId, "2026-05-26T09:00:00.000Z"],
    );
    await database.query(
      `INSERT INTO audit_events (id, account_id, workspace_id, event_type, event_status, metadata_json)
       VALUES ($1, $2, $3, 'chat.answer', 'success', $4::jsonb)`,
      [
        randomUUID(),
        accountId,
        workspaceId,
        JSON.stringify({
          assistantMessageId: legacyMessageId,
          activityTrace: { totalDurationMs: 6400 },
        }),
      ],
    );

    const service = new QualityTurnsService(database.kysely, stubOutcomeCatalog());

    const all = await service.listLowQualityTurns(workspaceId, { limit: 25 });
    const legacy = all.items.find((item) => item.assistantMessageId === legacyMessageId);
    expect(legacy?.totalLatencyMs).toBe(6400);

    const filtered = await service.listLowQualityTurns(workspaceId, {
      limit: 25,
      minTotalLatencyMs: 5000,
    });
    expect(filtered.items.map((item) => item.assistantMessageId)).toEqual([legacyMessageId]);
    expect(filtered.total).toBe(1);
  });

  it("prefers the answer stage over totalDurationMs when falling back, matching the backfill", async () => {
    const accountId = randomUUID();
    const workspaceId = randomUUID();
    const agentId = randomUUID();
    const conversationId = randomUUID();

    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [accountId, "Stage Latency Account", `stage-latency-${accountId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [workspaceId, accountId, "Stage Latency WS", `sl-${workspaceId.slice(0, 8)}`],
    );
    await database.query(
      `INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, $3)`,
      [agentId, workspaceId, "Stage Latency Bot"],
    );
    await database.query(
      `INSERT INTO conversations (id, workspace_id, agent_id, source_channel)
       VALUES ($1, $2, $3, 'embed')`,
      [conversationId, workspaceId, agentId],
    );

    const messageId = randomUUID();
    await database.query(
      `INSERT INTO messages
         (id, conversation_id, workspace_id, role, content, skill_name, skill_outcome, skill_status, created_at)
       VALUES ($1, $2, $3, 'assistant', 'Staged answer', 'retrieval.answer', 'grounded', 'completed', $4)`,
      [messageId, conversationId, workspaceId, "2026-05-26T09:00:00.000Z"],
    );

    // The two candidates disagree on purpose: totalDurationMs is retrieval-pipeline time,
    // the answer stage is turn wall time. The persisted column records the latter, so the
    // fallback has to agree or one column reports two different quantities.
    await database.query(
      `INSERT INTO audit_events (id, account_id, workspace_id, event_type, event_status, metadata_json)
       VALUES ($1, $2, $3, 'chat.answer', 'success', $4::jsonb)`,
      [
        randomUUID(),
        accountId,
        workspaceId,
        JSON.stringify({
          assistantMessageId: messageId,
          activityTrace: {
            totalDurationMs: 6400,
            stages: [
              { stageId: "retrieval", durationMs: 6400 },
              { stageId: "answer", durationMs: 8200 },
            ],
          },
        }),
      ],
    );

    const service = new QualityTurnsService(database.kysely, stubOutcomeCatalog());

    const all = await service.listLowQualityTurns(workspaceId, { limit: 25 });
    expect(all.items.find((item) => item.assistantMessageId === messageId)?.totalLatencyMs).toBe(
      8200,
    );

    // A filter set between the two values must follow the answer stage, not the retrieval time.
    const filtered = await service.listLowQualityTurns(workspaceId, {
      limit: 25,
      minTotalLatencyMs: 7000,
    });
    expect(filtered.items.map((item) => item.assistantMessageId)).toEqual([messageId]);
    expect(filtered.total).toBe(1);
  });

  it("returns the union of several signals, counting a turn that matches two only once", async () => {
    const accountId = randomUUID();
    const workspaceId = randomUUID();
    const agentId = randomUUID();
    const conversationId = randomUUID();

    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [accountId, "Signal Union Account", `signals-${accountId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [workspaceId, accountId, "Signal Union WS", `su-${workspaceId.slice(0, 8)}`],
    );
    await database.query(
      `INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, $3)`,
      [agentId, workspaceId, "Signal Bot"],
    );
    await database.query(
      `INSERT INTO conversations (id, workspace_id, agent_id, source_channel)
       VALUES ($1, $2, $3, 'embed')`,
      [conversationId, workspaceId, agentId],
    );

    const gapMessageId = randomUUID();
    const downVotedMessageId = randomUUID();
    const slowMessageId = randomUUID();
    const failedMessageId = randomUUID();
    // Slow *and* down-voted: the row an OR built out of joins or UNION ALL would return twice.
    const doubleSignalMessageId = randomUUID();
    const healthyMessageId = randomUUID();

    await database.query(
      `INSERT INTO messages
         (id, conversation_id, workspace_id, role, content, skill_name, skill_outcome, skill_status, total_latency_ms, created_at)
       VALUES
         ($1, $7, $8, 'assistant', 'No context answer',  'retrieval.answer', 'no_context',           'completed',   900, $9),
         ($2, $7, $8, 'assistant', 'Disliked answer',    'retrieval.answer', 'grounded',             'completed',   950, $10),
         ($3, $7, $8, 'assistant', 'Slow answer',        'retrieval.answer', 'grounded',             'completed', 12000, $11),
         ($4, $7, $8, 'assistant', 'Broken skill',       'retrieval.answer', 'clarification_needed', 'failed',      800, $12),
         ($5, $7, $8, 'assistant', 'Slow and disliked',  'retrieval.answer', 'grounded',             'completed', 15000, $13),
         ($6, $7, $8, 'assistant', 'Healthy answer',     'retrieval.answer', 'grounded',             'completed',   700, $14)`,
      [
        gapMessageId,
        downVotedMessageId,
        slowMessageId,
        failedMessageId,
        doubleSignalMessageId,
        healthyMessageId,
        conversationId,
        workspaceId,
        "2026-05-27T09:00:00.000Z",
        "2026-05-27T09:00:01.000Z",
        "2026-05-27T09:00:02.000Z",
        "2026-05-27T09:00:03.000Z",
        "2026-05-27T09:00:04.000Z",
        "2026-05-27T09:00:05.000Z",
      ],
    );

    // Two down votes on the doubly-signalled turn, so a fanned-out feedback join would
    // duplicate it a second way.
    await database.query(
      `INSERT INTO assistant_answer_feedback
         (id, workspace_id, conversation_id, assistant_message_id, actor_type, actor_id, value, comment)
       VALUES
         ($1, $2, $3, $4, 'authenticated_user', 'user-1', 'down', NULL),
         ($5, $2, $3, $6, 'authenticated_user', 'user-1', 'down', NULL),
         ($7, $2, $3, $6, 'authenticated_user', 'user-2', 'down', NULL)`,
      [
        randomUUID(),
        workspaceId,
        conversationId,
        downVotedMessageId,
        randomUUID(),
        doubleSignalMessageId,
        randomUUID(),
      ],
    );

    const service = new QualityTurnsService(database.kysely, stubOutcomeCatalog());

    const union = await service.listLowQualityTurns(workspaceId, {
      limit: 25,
      signals: ["negative_feedback", "grounding_gaps", "slow_responses", "skill_failures"],
    });

    const unionIds = union.items.map((item) => item.assistantMessageId);
    expect([...unionIds].sort()).toEqual(
      [
        gapMessageId,
        downVotedMessageId,
        slowMessageId,
        failedMessageId,
        doubleSignalMessageId,
      ].sort(),
    );
    // Exactly once each, and the healthy turn is not in the queue at all.
    expect(new Set(unionIds).size).toBe(unionIds.length);
    expect(unionIds).not.toContain(healthyMessageId);
    expect(union.total).toBe(5);

    // A two-signal query is the union of the two, still deduplicated.
    const slowOrNegative = await service.listLowQualityTurns(workspaceId, {
      limit: 25,
      signals: ["slow_responses", "negative_feedback"],
    });
    expect([...slowOrNegative.items.map((item) => item.assistantMessageId)].sort()).toEqual(
      [downVotedMessageId, slowMessageId, doubleSignalMessageId].sort(),
    );
    expect(slowOrNegative.total).toBe(3);

    // A repeated id is not a second predicate.
    const repeated = await service.listLowQualityTurns(workspaceId, {
      limit: 25,
      signals: ["skill_failures", "skill_failures"],
    });
    expect(repeated.items.map((item) => item.assistantMessageId)).toEqual([failedMessageId]);
    expect(repeated.total).toBe(1);

    // One signal behaves exactly as it did before the list.
    const gapsOnly = await service.listLowQualityTurns(workspaceId, {
      limit: 25,
      signals: ["grounding_gaps"],
    });
    expect(gapsOnly.items.map((item) => item.assistantMessageId)).toEqual([gapMessageId]);
    expect(gapsOnly.total).toBe(1);

    // Signals AND the explicit filters: the union narrowed to failed skills only.
    const unionWithStatus = await service.listLowQualityTurns(workspaceId, {
      limit: 25,
      signals: ["negative_feedback", "grounding_gaps", "slow_responses", "skill_failures"],
      statuses: ["failed"],
    });
    expect(unionWithStatus.items.map((item) => item.assistantMessageId)).toEqual([failedMessageId]);
    expect(unionWithStatus.total).toBe(1);
  });

  it("orders feedback by its latest update even when the answer is older than the first page", async () => {
    const accountId = randomUUID();
    const workspaceId = randomUUID();
    const conversationId = randomUUID();

    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [accountId, "Feedback Order Account", `feedback-order-${accountId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [workspaceId, accountId, "Feedback Order WS", `fo-${workspaceId.slice(0, 8)}`],
    );
    await database.query(
      `INSERT INTO conversations (id, workspace_id, source_channel) VALUES ($1, $2, 'embed')`,
      [conversationId, workspaceId],
    );

    const oldMessageId = randomUUID();
    await database.query(
      `INSERT INTO messages (id, conversation_id, workspace_id, role, content, created_at)
       VALUES ($1, $2, $3, 'assistant', 'Old answer with fresh feedback', $4)`,
      [oldMessageId, conversationId, workspaceId, "2026-01-01T00:00:00.000Z"],
    );
    await database.query(
      `INSERT INTO assistant_answer_feedback
         (id, workspace_id, conversation_id, assistant_message_id, actor_type, actor_id, value, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'authenticated_user', 'fresh-actor', 'down', $5, $5)`,
      [randomUUID(), workspaceId, conversationId, oldMessageId, "2026-06-30T12:00:00.000Z"],
    );

    for (let index = 0; index < 26; index += 1) {
      const messageId = randomUUID();
      const messageCreatedAt = new Date(Date.UTC(2026, 5, 1, 0, index)).toISOString();
      const feedbackUpdatedAt = new Date(Date.UTC(2026, 5, 1, 1, index)).toISOString();
      await database.query(
        `INSERT INTO messages (id, conversation_id, workspace_id, role, content, created_at)
         VALUES ($1, $2, $3, 'assistant', $4, $5)`,
        [messageId, conversationId, workspaceId, `Newer answer ${index}`, messageCreatedAt],
      );
      await database.query(
        `INSERT INTO assistant_answer_feedback
           (id, workspace_id, conversation_id, assistant_message_id, actor_type, actor_id, value, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'authenticated_user', $5, 'down', $6, $6)`,
        [randomUUID(), workspaceId, conversationId, messageId, `actor-${index}`, feedbackUpdatedAt],
      );
    }

    const service = new QualityTurnsService(database.kysely, stubOutcomeCatalog());
    const page = await service.listLowQualityTurns(workspaceId, {
      feedbackValues: ["down"],
      sort: "negative_feedback_updated_at",
      activeNegativeFeedbackOnly: true,
      limit: 25,
    });

    expect(page.items).toHaveLength(25);
    expect(page.items[0]?.assistantMessageId).toBe(oldMessageId);
    expect(page.items[0]?.feedback.latestDownUpdatedAt).toBe("2026-06-30T12:00:00.000Z");
  });

  it("treats negative feedback newer than terminal triage as active until it is triaged again", async () => {
    const accountId = randomUUID();
    const workspaceId = randomUUID();
    const conversationId = randomUUID();
    const messageId = randomUUID();

    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [accountId, "Feedback Triage Account", `feedback-triage-${accountId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [workspaceId, accountId, "Feedback Triage WS", `ft-${workspaceId.slice(0, 8)}`],
    );
    await database.query(
      `INSERT INTO conversations (id, workspace_id, source_channel) VALUES ($1, $2, 'embed')`,
      [conversationId, workspaceId],
    );
    await database.query(
      `INSERT INTO messages (id, conversation_id, workspace_id, role, content, created_at)
       VALUES ($1, $2, $3, 'assistant', 'Previously dismissed answer', $4)`,
      [messageId, conversationId, workspaceId, "2026-05-01T00:00:00.000Z"],
    );
    await database.query(
      `INSERT INTO assistant_answer_triage
         (workspace_id, assistant_message_id, state, updated_at)
       VALUES ($1, $2, 'dismissed', $3)`,
      [workspaceId, messageId, "2026-05-02T00:00:00.000Z"],
    );
    await database.query(
      `INSERT INTO assistant_answer_feedback
         (id, workspace_id, conversation_id, assistant_message_id, actor_type, actor_id, value, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'authenticated_user', 'later-actor', 'down', $5, $5)`,
      [randomUUID(), workspaceId, conversationId, messageId, "2026-05-03T00:00:00.000Z"],
    );

    const service = new QualityTurnsService(database.kysely, stubOutcomeCatalog());
    const reopened = await service.listLowQualityTurns(workspaceId, {
      feedbackValues: ["down"],
      sort: "negative_feedback_updated_at",
      activeNegativeFeedbackOnly: true,
      limit: 25,
    });

    expect(reopened.items).toHaveLength(1);
    expect(reopened.items[0]?.assistantMessageId).toBe(messageId);
    expect(reopened.items[0]?.triage).toEqual({
      state: "open",
      reason: null,
      updatedAt: null,
    });

    const reopenedOpenOnly = await service.listLowQualityTurns(workspaceId, {
      feedbackValues: ["down"],
      triageStates: ["open"],
      sort: "negative_feedback_updated_at",
      activeNegativeFeedbackOnly: true,
      limit: 25,
    });
    expect(reopenedOpenOnly.items).toHaveLength(1);
    expect(reopenedOpenOnly.items[0]?.triage.state).toBe("open");

    const reopenedResolvedOnly = await service.listLowQualityTurns(workspaceId, {
      feedbackValues: ["down"],
      triageStates: ["resolved"],
      sort: "negative_feedback_updated_at",
      activeNegativeFeedbackOnly: true,
      limit: 25,
    });
    expect(reopenedResolvedOnly.items).toHaveLength(0);

    await service.setTriageState(workspaceId, {
      assistantMessageId: messageId,
      state: "resolved",
    });
    const resolved = await service.listLowQualityTurns(workspaceId, {
      feedbackValues: ["down"],
      sort: "negative_feedback_updated_at",
      activeNegativeFeedbackOnly: true,
      limit: 25,
    });

    expect(resolved.items).toHaveLength(0);
  });

  it("returns null when setting triage on a turn outside the workspace", async () => {
    const accountId = randomUUID();
    const workspaceId = randomUUID();

    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [accountId, "No Turn Account", `noturn-${accountId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [workspaceId, accountId, "No Turn WS", `nt-${workspaceId.slice(0, 8)}`],
    );

    const service = new QualityTurnsService(database.kysely, stubOutcomeCatalog());
    const result = await service.setTriageState(workspaceId, {
      assistantMessageId: randomUUID(),
      state: "acknowledged",
    });
    expect(result).toBeNull();
  });
});
