import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Database } from "../../src/shared/infra/database.js";
import { runTestMigrationsBefore, testMigrationsPath } from "../support/databaseMigrations.js";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const addV2Check = "211_conversation_activity_kind_v2_add.sql";
const validateV2Check = "212_conversation_activity_kind_v2_validate.sql";
const dropV1Check = "213_conversation_activity_kind_drop_v1.sql";
const closedIndexV2 = "214_conversation_activity_closed_idx_v2.sql";

const NEW_KINDS = [
  "channel_exception",
  "delivery_failed",
  "delivery_failure_cleared",
  "held_reply_released",
  "held_reply_discarded",
] as const;

const V2_CLOSING_KINDS = [
  "handed_back",
  "approval_decided",
  "feedback_resolved",
  "feedback_dismissed",
  "held_reply_released",
  "delivery_failure_cleared",
] as const;

const LOCK_NOT_AVAILABLE = "55P03";
const CHECK_VIOLATION = "23514";

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

const migrationSql = (file: string): Promise<string> => readFile(path.join(testMigrationsPath, file), "utf8");

// The production runner's shape: one transaction per file, body timeouts disabled first, so only a
// migration's own `SET LOCAL` bounds how long it waits for a lock.
const applyAsRunner = async (database: Database, file: string): Promise<void> => {
  const sql = await migrationSql(file);
  await database.withTransaction(async (client) => {
    await client.query("SET LOCAL lock_timeout = 0");
    await client.query("SET LOCAL statement_timeout = 0");
    await client.query(sql);
  });
};

const errorCode = async (work: Promise<unknown>): Promise<string | undefined> => {
  try {
    await work;
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

const describeIfDatabase = await canReach(integrationDatabaseUrl) ? describe : describe.skip;

describeIfDatabase("conversation activity kinds, widened online (211–214)", () => {
  const databaseName = `mig211_${randomUUID().replaceAll("-", "")}`;
  const workspaceId = randomUUID();
  const conversationId = randomUUID();
  let admin: Database;
  let database: Database;

  const insertActivity = (kind: string) =>
    database.execute(
      "INSERT INTO conversation_activity (conversation_id, workspace_id, kind) VALUES ($1, $2, $3)",
      [conversationId, workspaceId, kind],
    );

  const constraint = (name: string) =>
    database.queryOptional<{ convalidated: boolean }>(
      `SELECT convalidated
         FROM pg_constraint
        WHERE conrelid = 'conversation_activity'::regclass AND conname = $1`,
      [name],
    );

  // A second session holding `mode` on the table while `file` runs, as application traffic would.
  const applyWhileLocked = async (file: string, mode: string): Promise<string | undefined> => {
    const holder = await database.pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(`LOCK TABLE conversation_activity IN ${mode} MODE`);
      return await errorCode(applyAsRunner(database, file));
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
  };

  beforeAll(async () => {
    admin = new Database(integrationDatabaseUrl!);
    await admin.execute(`CREATE DATABASE "${databaseName}"`);
    database = new Database(isolatedUrl(integrationDatabaseUrl!, databaseName));
    await runTestMigrationsBefore(database, addV2Check);

    const accountId = randomUUID();
    await database.execute(
      "INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, 'Acct', $2, 'hash')",
      [accountId, `mig211-${accountId}@example.com`],
    );
    await database.execute(
      "INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, 'WS', $3)",
      [workspaceId, accountId, `rk-${workspaceId}`],
    );
    await database.execute(
      "INSERT INTO conversations (id, workspace_id, source_channel) VALUES ($1, $2, 'embed')",
      [conversationId, workspaceId],
    );
    // Rows written before the widening must survive VALIDATE.
    await insertActivity("handed_back");
    await insertActivity("feedback_dismissed");
  }, 120_000);

  afterAll(async () => {
    await database?.close().catch(() => undefined);
    await admin?.execute(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
    await admin?.close().catch(() => undefined);
  });

  it("bounds the lock wait of each exclusive phase, and of the index build, to three seconds", async () => {
    for (const file of [addV2Check, dropV1Check, closedIndexV2]) {
      expect(await migrationSql(file), file).toMatch(/SET LOCAL lock_timeout = '3s';/);
    }
    // VALIDATE takes SHARE UPDATE EXCLUSIVE, which writers never wait for: it needs no bound.
    expect(await migrationSql(validateV2Check)).toMatch(/VALIDATE CONSTRAINT conversation_activity_kind_v2_check/);
  });

  it("phase 1 fails fast behind a reader instead of queueing traffic behind it, then adds the v2 CHECK unvalidated", async () => {
    expect(await applyWhileLocked(addV2Check, "ACCESS SHARE")).toBe(LOCK_NOT_AVAILABLE);
    expect(await constraint("conversation_activity_kind_v2_check")).toBeNull();

    await applyAsRunner(database, addV2Check);

    expect(await constraint("conversation_activity_kind_v2_check")).toEqual({ convalidated: false });
    expect(await constraint("conversation_activity_kind_check")).toEqual({ convalidated: true });
    // The v1 CHECK still holds: no new kind is written before phase 3.
    for (const kind of NEW_KINDS) {
      expect(await errorCode(insertActivity(kind)), kind).toBe(CHECK_VIOLATION);
    }
  });

  it("phase 2 validates the v2 CHECK against existing rows while writers continue", async () => {
    const writer = await database.pool.connect();
    try {
      await writer.query("BEGIN");
      await writer.query(
        "INSERT INTO conversation_activity (conversation_id, workspace_id, kind) VALUES ($1, $2, 'claimed')",
        [conversationId, workspaceId],
      );
      await applyAsRunner(database, validateV2Check);
      await writer.query("COMMIT");
    } finally {
      writer.release();
    }

    expect(await constraint("conversation_activity_kind_v2_check")).toEqual({ convalidated: true });
  });

  it("phase 3 fails fast behind a reader, then drops the v1 CHECK so the five new kinds insert", async () => {
    expect(await applyWhileLocked(dropV1Check, "ACCESS SHARE")).toBe(LOCK_NOT_AVAILABLE);
    expect(await constraint("conversation_activity_kind_check")).toEqual({ convalidated: true });

    await applyAsRunner(database, dropV1Check);

    expect(await constraint("conversation_activity_kind_check")).toBeNull();
    for (const kind of NEW_KINDS) {
      await insertActivity(kind);
    }
    const kinds = await database.query<{ kind: string }>(
      "SELECT kind FROM conversation_activity WHERE kind = ANY($1::text[]) ORDER BY kind",
      [[...NEW_KINDS]],
    );
    expect(kinds.map((row) => row.kind)).toEqual([...NEW_KINDS].sort());
  });

  it("still rejects unknown kinds", async () => {
    expect(await errorCode(insertActivity("email_sent"))).toBe(CHECK_VIOLATION);
    expect(await errorCode(insertActivity("Handed_Back"))).toBe(CHECK_VIOLATION);
  });

  it("re-applying any phase changes nothing", async () => {
    for (const file of [addV2Check, validateV2Check, dropV1Check]) {
      await applyAsRunner(database, file);
    }
    expect(await constraint("conversation_activity_kind_v2_check")).toEqual({ convalidated: true });
    expect(await constraint("conversation_activity_kind_check")).toBeNull();
  });

  it("builds the v2 closing index, bounded behind a writer, over the extended closing kinds", async () => {
    expect(await applyWhileLocked(closedIndexV2, "ROW EXCLUSIVE")).toBe(LOCK_NOT_AVAILABLE);

    await applyAsRunner(database, closedIndexV2);
    await applyAsRunner(database, closedIndexV2);

    const index = await database.queryOne<{ definition: string; predicate: string; valid: boolean }>(
      `SELECT pg_get_indexdef(i.indexrelid) AS definition,
              pg_get_expr(i.indpred, i.indrelid) AS predicate,
              i.indisvalid AS valid
         FROM pg_index i
        WHERE i.indexrelid = 'conversation_activity_workspace_closed_v2_idx'::regclass`,
    );
    expect(index.valid).toBe(true);
    expect(index.definition).toContain("(workspace_id, created_at DESC)");
    const predicateKinds = [...index.predicate.matchAll(/'([a-z_]+)'::text/g)].map((match) => match[1]).sort();
    expect(predicateKinds).toEqual([...V2_CLOSING_KINDS].sort());
    // The v1 index stays until S2, while a running version still reads through it.
    const v1 = await database.queryOptional<{ name: string }>(
      "SELECT to_regclass('conversation_activity_workspace_closed_idx')::text AS name",
    );
    expect(v1?.name).toBe("conversation_activity_workspace_closed_idx");
  });

  it("serves the recently-closed query over the v2 closing kinds from the v2 index", async () => {
    // The shape of ConversationActivityRepository.listRecentClosing: kinds as literals, so the
    // planner can match the partial index's predicate.
    const kindList = V2_CLOSING_KINDS.map((kind) => `'${kind}'`).join(", ");
    const plan = await database.withTransaction(async (client) => {
      await client.query("SET LOCAL enable_seqscan = off");
      const result = await client.query<{ "QUERY PLAN": string }>(
        `EXPLAIN
         SELECT a.id, a.conversation_id, a.workspace_id, a.kind, a.actor_user_id, a.subject_user_id, a.detail,
                a.created_at, c.title AS conversation_title
           FROM conversation_activity a
           JOIN conversations c
             ON c.id = a.conversation_id
          WHERE a.workspace_id = $1
            AND a.kind IN (${kindList})
            AND (c.source_channel IS NULL OR c.source_channel NOT IN ('authenticated_chat'))
          ORDER BY a.created_at DESC, a.id DESC
          LIMIT 20`,
        [workspaceId],
      );
      return result.rows.map((row) => row["QUERY PLAN"]).join("\n");
    });

    expect(plan).toContain("conversation_activity_workspace_closed_v2_idx");
  });
});
