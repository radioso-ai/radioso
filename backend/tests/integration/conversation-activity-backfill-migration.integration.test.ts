import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Database } from "../../src/shared/infra/database.js";
import { applyTestMigration, runTestMigrationsBefore } from "../support/databaseMigrations.js";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;
const migrationFile = "204_conversation_activity.sql";

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

const daysAgo = (days: number): Date => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

describeIfDatabase("conversation activity migration's feedback backfill (204)", () => {
  const databaseName = `mig204_${randomUUID().replaceAll("-", "")}`;
  let admin: Database;
  let database: Database;

  beforeAll(async () => {
    admin = new Database(integrationDatabaseUrl!);
    await admin.execute(`CREATE DATABASE "${databaseName}"`);
    database = new Database(isolatedUrl(integrationDatabaseUrl!, databaseName));
    await runTestMigrationsBefore(database, migrationFile);
  }, 120_000);

  afterAll(async () => {
    await database?.close().catch(() => undefined);
    await admin?.execute(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
    await admin?.close().catch(() => undefined);
  });

  it("records the feedback closed in the last 30 days, as the live writer would, once", async () => {
    const accountId = randomUUID();
    const workspaceId = randomUUID();
    const beaId = randomUUID();
    const conversationId = randomUUID();
    const testChatId = randomUUID();
    await database.execute(
      "INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, 'Acct', $2, 'hash')",
      [accountId, `mig204-${accountId}@example.com`],
    );
    await database.execute(
      "INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, 'WS', $3)",
      [workspaceId, accountId, `rk-${workspaceId}`],
    );
    await database.execute(
      "INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, 'hash', 'Bea')",
      [beaId, `bea-${beaId}@example.com`],
    );
    await database.execute(
      "INSERT INTO conversations (id, workspace_id, source_channel) VALUES ($1, $2, 'embed'), ($3, $2, 'authenticated_chat')",
      [conversationId, workspaceId, testChatId],
    );
    const answer = async (conversation: string): Promise<string> => {
      const id = randomUUID();
      await database.execute(
        "INSERT INTO messages (id, conversation_id, workspace_id, role, content) VALUES ($1, $2, $3, 'assistant', 'An answer.')",
        [id, conversation, workspaceId],
      );
      return id;
    };
    const reopened = await answer(conversationId);
    const dismissedOnce = await answer(conversationId);
    const longAgo = await answer(conversationId);
    const inTestChat = await answer(testChatId);
    const versions = new Map<string, number>();
    const transition = async (
      messageId: string,
      from: string,
      to: string,
      at: Date,
      options: { actorId?: string | null; reason?: string | null } = {},
    ) => {
      const version = (versions.get(messageId) ?? 0) + 1;
      versions.set(messageId, version);
      await database.execute(
        `INSERT INTO assistant_answer_triage_transitions (
           workspace_id, assistant_message_id, prior_state, next_state, resulting_version, actor_id,
           resolution_reason, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [workspaceId, messageId, from, to, version, options.actorId ?? null, options.reason ?? null, at],
      );
    };
    const resolvedAt = daysAgo(4);
    const dismissedAt = daysAgo(2);
    const redismissedAt = daysAgo(1);
    await transition(reopened, "open", "acknowledged", daysAgo(5), { actorId: beaId });
    await transition(reopened, "acknowledged", "resolved", resolvedAt, { actorId: beaId, reason: "knowledge_gap" });
    // A re-save of a closed state closes nothing.
    await transition(reopened, "resolved", "resolved", daysAgo(3), { actorId: beaId, reason: "other" });
    await transition(reopened, "resolved", "dismissed", redismissedAt, { actorId: beaId, reason: "out_of_scope" });
    await transition(dismissedOnce, "open", "dismissed", dismissedAt);
    await transition(longAgo, "open", "resolved", daysAgo(40), { actorId: beaId, reason: "knowledge_gap" });
    await transition(inTestChat, "open", "resolved", daysAgo(1), { actorId: beaId, reason: "knowledge_gap" });

    await applyTestMigration(database, migrationFile);
    await applyTestMigration(database, migrationFile);

    const rows = await database.query<{
      conversation_id: string;
      workspace_id: string;
      kind: string;
      actor_user_id: string | null;
      subject_user_id: string | null;
      detail: Record<string, unknown>;
      created_at: Date;
    }>(
      `SELECT conversation_id, workspace_id, kind, actor_user_id, subject_user_id, detail, created_at
         FROM conversation_activity
        ORDER BY created_at`,
    );
    expect(rows).toEqual([
      {
        conversation_id: conversationId,
        workspace_id: workspaceId,
        kind: "feedback_resolved",
        actor_user_id: beaId,
        subject_user_id: null,
        detail: { assistantMessageId: reopened, resolution: "knowledge_gap" },
        created_at: resolvedAt,
      },
      {
        conversation_id: conversationId,
        workspace_id: workspaceId,
        kind: "feedback_dismissed",
        actor_user_id: null,
        subject_user_id: null,
        detail: { assistantMessageId: dismissedOnce, resolution: null },
        created_at: dismissedAt,
      },
      {
        conversation_id: conversationId,
        workspace_id: workspaceId,
        kind: "feedback_dismissed",
        actor_user_id: beaId,
        subject_user_id: null,
        detail: { assistantMessageId: reopened, resolution: "out_of_scope" },
        created_at: redismissedAt,
      },
    ]);
  });
});
