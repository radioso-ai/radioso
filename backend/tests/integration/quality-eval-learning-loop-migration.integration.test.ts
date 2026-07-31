import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Database } from "../../src/shared/infra/database.js";
import {
  applyTestMigration,
  runTestMigrationsBefore,
} from "../support/databaseMigrations.js";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;
const migrationFile = "133_quality_eval_learning_loop.sql";

const canReach = async (url?: string) => {
  if (!url) return false;
  const database = new Database(url);
  try {
    await database.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await database.close().catch(() => undefined);
  }
};

const isolatedUrl = (base: string, name: string) => {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
};

const describeIfDatabase = await canReach(integrationDatabaseUrl) ? describe : describe.skip;

describeIfDatabase("quality Eval learning-loop migration (133)", () => {
  const databaseName = `mig133_${randomUUID().replaceAll("-", "")}`;
  let admin: Database;
  let database: Database;

  beforeAll(async () => {
    admin = new Database(integrationDatabaseUrl!);
    await admin.execute(`CREATE DATABASE "${databaseName}"`);
    database = new Database(isolatedUrl(integrationDatabaseUrl!, databaseName));
    await runTestMigrationsBefore(database, migrationFile);
  });

  afterAll(async () => {
    await database?.close().catch(() => undefined);
    await admin?.execute(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
    await admin?.close().catch(() => undefined);
  });

  it("backfills existing triage rows without fabricating structured reasons", async () => {
    const accountId = randomUUID();
    const workspaceId = randomUUID();
    const conversationId = randomUUID();
    const messageId = randomUUID();
    const olderSnapshotId = randomUUID();
    const newerSnapshotId = randomUUID();
    const olderCaseId = randomUUID();
    const newerCaseId = randomUUID();
    await database.execute(
      "INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, 'Acct', $2, 'hash')",
      [accountId, `mig133-${accountId}@example.com`],
    );
    await database.execute(
      "INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, 'WS', $3)",
      [workspaceId, accountId, `rk-${workspaceId}`],
    );
    await database.execute(
      "INSERT INTO conversations (id, workspace_id) VALUES ($1, $2)",
      [conversationId, workspaceId],
    );
    await database.execute(
      "INSERT INTO messages (id, conversation_id, workspace_id, role, content) VALUES ($1, $2, $3, 'assistant', 'answer')",
      [messageId, conversationId, workspaceId],
    );
    await database.execute(
      `INSERT INTO assistant_answer_triage
         (workspace_id, assistant_message_id, state, reason, updated_at)
       VALUES ($1, $2, 'resolved', 'legacy free text', '2026-07-01T10:00:00Z')`,
      [workspaceId, messageId],
    );
    await database.execute(
      `INSERT INTO eval_snapshots
         (id, workspace_id, source_conversation_id, source_message_id, fidelity, messages)
       VALUES
         ($1, $3, $4, $5, 'messages_only', '[]'::jsonb),
         ($2, $3, $4, $5, 'messages_only', '[]'::jsonb)`,
      [olderSnapshotId, newerSnapshotId, workspaceId, conversationId, messageId],
    );
    await database.execute(
      `INSERT INTO eval_cases
         (id, workspace_id, snapshot_id, name, status, created_at, updated_at)
       VALUES
         ($1, $3, $4, 'Older', 'pending', '2026-07-01T08:00:00Z', '2026-07-01T08:00:00Z'),
         ($2, $3, $5, 'Newer', 'pending', '2026-07-01T09:00:00Z', '2026-07-01T09:00:00Z')`,
      [olderCaseId, newerCaseId, workspaceId, olderSnapshotId, newerSnapshotId],
    );

    await applyTestMigration(database, migrationFile);

    const [row] = await database.query<{
      version: number;
      resolution_reason: string | null;
      resolution_note: string | null;
      closed_at: Date | null;
    }>(
      `SELECT version, resolution_reason, resolution_note, closed_at
       FROM assistant_answer_triage
       WHERE workspace_id = $1 AND assistant_message_id = $2`,
      [workspaceId, messageId],
    );
    expect(row).toMatchObject({
      version: 1,
      resolution_reason: null,
      resolution_note: null,
    });
    expect(row?.closed_at?.toISOString()).toBe("2026-07-01T10:00:00.000Z");
    const [association] = await database.query<{ case_id: string }>(
      `SELECT case_id
       FROM eval_message_case_associations
       WHERE workspace_id = $1 AND assistant_message_id = $2`,
      [workspaceId, messageId],
    );
    expect(association?.case_id).toBe(newerCaseId);
  });

  it("adds append-only transition storage with no note column", async () => {
    const columns = await database.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'assistant_answer_triage_transitions'`,
    );
    expect(columns.map((column) => column.column_name)).toContain("resolution_reason");
    expect(columns.map((column) => column.column_name)).not.toContain("resolution_note");
  });

  it("enforces one current Eval case per workspace message and cascades case deletion", async () => {
    const accountId = randomUUID();
    const workspaceId = randomUUID();
    const conversationId = randomUUID();
    const messageId = randomUUID();
    const secondMessageId = randomUUID();
    const snapshotId = randomUUID();
    const caseId = randomUUID();
    await database.execute(
      "INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, 'Assoc', $2, 'hash')",
      [accountId, `mig133-assoc-${accountId}@example.com`],
    );
    await database.execute(
      "INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, 'WS', $3)",
      [workspaceId, accountId, `assoc-${workspaceId}`],
    );
    await database.execute(
      "INSERT INTO conversations (id, workspace_id) VALUES ($1, $2)",
      [conversationId, workspaceId],
    );
    await database.execute(
      `INSERT INTO messages (id, conversation_id, workspace_id, role, content)
       VALUES
         ($1, $3, $4, 'assistant', 'answer'),
         ($2, $3, $4, 'assistant', 'another answer')`,
      [messageId, secondMessageId, conversationId, workspaceId],
    );
    await database.execute(
      `INSERT INTO eval_snapshots
         (id, workspace_id, source_conversation_id, source_message_id, fidelity, messages)
       VALUES ($1, $2, $3, $4, 'messages_only', '[]'::jsonb)`,
      [snapshotId, workspaceId, conversationId, messageId],
    );
    await database.execute(
      `INSERT INTO eval_cases (id, workspace_id, snapshot_id, name, status)
       VALUES ($1, $2, $3, 'Case', 'pending')`,
      [caseId, workspaceId, snapshotId],
    );
    await database.execute(
      `INSERT INTO eval_message_case_associations
         (workspace_id, assistant_message_id, case_id)
       VALUES ($1, $2, $3)`,
      [workspaceId, messageId, caseId],
    );

    await expect(database.execute(
      `INSERT INTO eval_message_case_associations
         (workspace_id, assistant_message_id, case_id)
       VALUES ($1, $2, $3)`,
      [workspaceId, secondMessageId, caseId],
    )).rejects.toThrow();

    await database.execute("DELETE FROM eval_cases WHERE id = $1", [caseId]);
    const remaining = await database.query(
      "SELECT 1 FROM eval_message_case_associations WHERE case_id = $1",
      [caseId],
    );
    expect(remaining).toHaveLength(0);
  });
});
