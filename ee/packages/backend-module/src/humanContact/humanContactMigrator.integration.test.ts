import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

import { skillSubmissionMigrator } from "../skillSubmissions/skillSubmissionMigrator.js";
import { humanContactMigrator } from "./humanContactMigrator.js";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const quoteIdentifier = (value: string): string => `"${value.replaceAll("\"", "\"\"")}"`;

const disposableDatabaseName = (): string =>
  `radioso_human_contact_migrator_${randomUUID().replaceAll("-", "_")}`;

const databaseUrlForName = (databaseUrl: string, databaseName: string): string => {
  const url = new URL(databaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
};

const createDisposableBackfillDatabase = async (
  databaseUrl?: string,
): Promise<{ name: string; connectionString: string } | null> => {
  if (!databaseUrl) {
    return null;
  }
  const pool = new Pool({ connectionString: databaseUrl });
  const name = disposableDatabaseName();
  try {
    await pool.query(`CREATE DATABASE ${quoteIdentifier(name)}`);
    return {
      name,
      connectionString: databaseUrlForName(databaseUrl, name),
    };
  } catch {
    return null;
  } finally {
    await pool.end().catch(() => undefined);
  }
};

const dropDisposableBackfillDatabase = async (databaseUrl: string, databaseName: string): Promise<void> => {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await pool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
  } finally {
    await pool.end().catch(() => undefined);
  }
};

const createMinimalBaseSchema = async (pool: Pool): Promise<void> => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id UUID PRIMARY KEY,
      account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id UUID PRIMARY KEY,
      workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      agent_id UUID,
      source_channel TEXT,
      source_origin TEXT,
      anonymous_session_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id UUID PRIMARY KEY,
      conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
};

const disposableBackfillDatabase = await createDisposableBackfillDatabase(integrationDatabaseUrl);
const describeIfDatabase = disposableBackfillDatabase ? describe : describe.skip;

describeIfDatabase("humanContactMigrator backfill integration", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: disposableBackfillDatabase?.connectionString });
  });

  afterAll(async () => {
    await pool.end();
    if (integrationDatabaseUrl && disposableBackfillDatabase) {
      await dropDisposableBackfillDatabase(integrationDatabaseUrl, disposableBackfillDatabase.name);
    }
  });

  it("moves legacy contact requests into skill submissions and drops the legacy table", async () => {
    const accountId = randomUUID();
    const workspaceId = randomUUID();
    const conversationId = randomUUID();
    const requestId = randomUUID();
    const idempotencyKey = `legacy-${randomUUID()}`;

    const database = {
      query: (text: string, params?: unknown[]) => pool.query(text, params),
    };

    await createMinimalBaseSchema(pool);
    await pool.query(
      `INSERT INTO accounts (id, name, email, password_hash)
       VALUES ($1, $2, $3, $4)`,
      [accountId, "Legacy Contact Account", `legacy-contact-${accountId}@example.com`, "hash"],
    );
    await pool.query(
      `INSERT INTO workspaces (id, account_id, name)
       VALUES ($1, $2, $3)`,
      [workspaceId, accountId, "Legacy Contact Workspace"],
    );
    await pool.query(
      `INSERT INTO conversations (id, workspace_id, source_channel)
       VALUES ($1, $2, $3)`,
      [conversationId, workspaceId, "authenticated_chat"],
    );
    await pool.query(`
      CREATE TABLE ee_contact_requests (
        id UUID PRIMARY KEY,
        account_id UUID,
        workspace_id UUID NOT NULL,
        conversation_id UUID NOT NULL,
        assistant_message_id UUID,
        user_email TEXT NOT NULL,
        message TEXT NOT NULL,
        source_channel TEXT,
        source_origin TEXT,
        trigger_source TEXT NOT NULL,
        trigger_reason TEXT,
        idempotency_key TEXT,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        final_delivery_error TEXT,
        activity_trace JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(
      `INSERT INTO ee_contact_requests (
         id, account_id, workspace_id, conversation_id, assistant_message_id,
         user_email, message, source_channel, source_origin, trigger_source, trigger_reason,
         idempotency_key, status, attempts, next_retry_at, final_delivery_error, activity_trace,
         created_at, updated_at
       )
       VALUES (
         $1, $2, $3, $4, NULL,
         $5, $6, $7, NULL, $8, NULL,
         $9, 'pending', 2, NOW(), NULL, $10::jsonb,
         NOW(), NOW()
       )`,
      [
        requestId,
        accountId,
        workspaceId,
        conversationId,
        " Visitor@Example.com ",
        "Please contact me.",
        "authenticated_chat",
        "manual",
        idempotencyKey,
        JSON.stringify({ traceId: "trace-legacy", stages: [], links: [] }),
      ],
    );

    await skillSubmissionMigrator.migrate(database);
    await humanContactMigrator.migrate(database);

    const migrated = await pool.query<{
      skill_name: string;
      subject_identity: string;
      fields: { email?: string; message?: string };
      idempotency_key: string;
      attempts: number;
    }>(
      `SELECT skill_name, subject_identity, fields, idempotency_key, attempts
       FROM skill_submissions
       WHERE id = $1`,
      [requestId],
    );
    expect(migrated.rows).toHaveLength(1);
    expect(migrated.rows[0]).toMatchObject({
      skill_name: "human_contact.request",
      subject_identity: "visitor@example.com",
      idempotency_key: idempotencyKey,
      attempts: 2,
    });
    expect(migrated.rows[0]?.fields).toEqual({
      email: "Visitor@Example.com",
      message: "Please contact me.",
    });

    const legacyTable = await pool.query<{ table_name: string | null }>(
      "SELECT to_regclass('public.ee_contact_requests')::text AS table_name",
    );
    expect(legacyTable.rows[0]?.table_name).toBeNull();
  });
});
