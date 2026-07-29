import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Database } from "../../src/shared/infra/database.js";
import {
  applyTestMigration,
  runTestMigrationsBefore,
} from "../support/databaseMigrations.js";

// Migration 131 moves per-turn latency out of audit_events.metadata_json and onto
// messages.total_latency_ms. New turns write the column directly; every turn that
// already shipped only has the `chat.answer` audit event, so the migration backfills
// them. This pins the backfill against the pre-131 schema — the only shape where the
// column starts empty — and pins the two shapes it must NOT fill: a non-numeric trace
// value and a turn with no matching event.
const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;
const migrationFile = "131_message_total_latency.sql";

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

const isolatedDatabaseUrl = (baseUrl: string, databaseName: string): string => {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
};

const hasReachableDatabase = await canReachIntegrationDatabase(integrationDatabaseUrl);
const describeIfDatabase = hasReachableDatabase ? describe : describe.skip;

describeIfDatabase("message total latency migration (131)", () => {
  const isolatedName = `mig131_${randomUUID().replace(/-/g, "")}`;
  let admin: Database;
  let database: Database;

  beforeAll(async () => {
    admin = new Database(integrationDatabaseUrl!);
    await admin.execute(`CREATE DATABASE "${isolatedName}"`);
    database = new Database(isolatedDatabaseUrl(integrationDatabaseUrl!, isolatedName));
    await runTestMigrationsBefore(database, migrationFile);
  });

  afterAll(async () => {
    await database?.close().catch(() => undefined);
    if (admin) {
      await admin.execute(`DROP DATABASE IF EXISTS "${isolatedName}" WITH (FORCE)`).catch(() => undefined);
      await admin.close().catch(() => undefined);
    }
  });

  it("backfills total_latency_ms from the latest chat.answer audit event", async () => {
    const accountId = randomUUID();
    const workspaceId = randomUUID();
    const agentId = randomUUID();
    const conversationId = randomUUID();

    await database.execute(
      "INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, 'Acct', $2, 'hash')",
      [accountId, `mig131-${accountId}@example.com`],
    );
    await database.execute(
      "INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, 'WS', $3)",
      [workspaceId, accountId, `rk-${workspaceId}`],
    );
    await database.execute(
      "INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, 'Agent')",
      [agentId, workspaceId],
    );
    await database.execute(
      "INSERT INTO conversations (id, workspace_id, agent_id, source_channel) VALUES ($1, $2, $3, 'embed')",
      [conversationId, workspaceId, agentId],
    );

    const backfilledMessageId = randomUUID();
    const nonNumericMessageId = randomUUID();
    const eventlessMessageId = randomUUID();
    const answerStageMessageId = randomUUID();

    await database.execute(
      `INSERT INTO messages (id, conversation_id, workspace_id, role, content, created_at)
       VALUES
         ($1, $5, $6, 'assistant', 'Backfilled answer', '2026-05-01T09:00:00.000Z'),
         ($2, $5, $6, 'assistant', 'Non-numeric answer', '2026-05-01T09:00:01.000Z'),
         ($3, $5, $6, 'assistant', 'Eventless answer', '2026-05-01T09:00:02.000Z'),
         ($4, $5, $6, 'assistant', 'Answer-stage answer', '2026-05-01T09:00:03.000Z')`,
      [
        backfilledMessageId,
        nonNumericMessageId,
        eventlessMessageId,
        answerStageMessageId,
        conversationId,
        workspaceId,
      ],
    );

    const insertAnswerEvent = async (
      metadata: Record<string, unknown>,
      createdAt: string,
    ): Promise<void> => {
      await database.execute(
        `INSERT INTO audit_events (id, account_id, workspace_id, event_type, event_status, metadata_json, created_at)
         VALUES ($1, $2, $3, 'chat.answer', 'success', $4::jsonb, $5)`,
        [randomUUID(), accountId, workspaceId, JSON.stringify(metadata), createdAt],
      );
    };

    // Two events for the same turn: the migration must take the latest.
    await insertAnswerEvent(
      { assistantMessageId: backfilledMessageId, activityTrace: { totalDurationMs: 1111 } },
      "2026-05-01T09:00:05.000Z",
    );
    await insertAnswerEvent(
      { assistantMessageId: backfilledMessageId, activityTrace: { totalDurationMs: 4321 } },
      "2026-05-01T09:00:09.000Z",
    );
    await insertAnswerEvent(
      { assistantMessageId: nonNumericMessageId, activityTrace: { totalDurationMs: "slow" } },
      "2026-05-01T09:00:06.000Z",
    );
    // The `answer` stage carries true turn wall time; totalDurationMs is retrieval-only.
    // The stage must win, so backfilled rows measure the same thing as new rows.
    await insertAnswerEvent(
      {
        assistantMessageId: answerStageMessageId,
        activityTrace: {
          totalDurationMs: 900,
          stages: [
            { stageId: "generation", durationMs: 7700 },
            { stageId: "answer", durationMs: 7700 },
          ],
        },
      },
      "2026-05-01T09:00:07.000Z",
    );

    await expect(applyTestMigration(database, migrationFile)).resolves.not.toThrow();

    const rows = await database.query<{ id: string; total_latency_ms: number | null }>(
      "SELECT id, total_latency_ms FROM messages WHERE workspace_id = $1 ORDER BY created_at",
      [workspaceId],
    );

    expect(rows).toEqual([
      { id: backfilledMessageId, total_latency_ms: 4321 },
      { id: nonNumericMessageId, total_latency_ms: null },
      { id: eventlessMessageId, total_latency_ms: null },
      { id: answerStageMessageId, total_latency_ms: 7700 },
    ]);
  });
});
