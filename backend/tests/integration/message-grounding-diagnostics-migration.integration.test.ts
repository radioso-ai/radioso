import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Database } from "../../src/shared/infra/database.js";
import { applyTestMigration, runTestMigrationsBefore } from "../support/databaseMigrations.js";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;
const migrationFile = "132_message_grounding_diagnostics.sql";

const canReach = async (url?: string) => {
  if (!url) return false;
  const db = new Database(url);
  try { await db.query("SELECT 1"); return true; } catch { return false; } finally { await db.close().catch(() => undefined); }
};
const isolatedUrl = (base: string, name: string) => {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
};
const describeIfDatabase = await canReach(integrationDatabaseUrl) ? describe : describe.skip;

describeIfDatabase("message grounding diagnostics migration (132)", () => {
  const databaseName = `mig132_${randomUUID().replace(/-/g, "")}`;
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

  it("uses only the newest answer/suspended event and leaves invalid newest data null", async () => {
    const accountId = randomUUID();
    const workspaceId = randomUUID();
    const conversationId = randomUUID();
    const validMessageId = randomUUID();
    const noFallbackMessageId = randomUUID();
    const malformedMessageId = randomUUID();
    const inconsistentMessageId = randomUUID();
    const tieMessageId = randomUUID();
    const preservedMessageId = randomUUID();
    await database.execute(`
      ALTER TABLE messages
        ADD COLUMN grounding_verdict TEXT,
        ADD COLUMN grounding_claim_count INTEGER,
        ADD COLUMN grounding_sourced_claim_count INTEGER,
        ADD COLUMN grounding_unsourced_claim_count INTEGER,
        ADD COLUMN grounding_invalid_source_count INTEGER
    `);
    await database.execute(
      "INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, 'Acct', $2, 'hash')",
      [accountId, `mig132-${accountId}@example.com`],
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
      `INSERT INTO messages (
         id, conversation_id, workspace_id, role, content, grounding_verdict,
         grounding_claim_count, grounding_sourced_claim_count,
         grounding_unsourced_claim_count, grounding_invalid_source_count
       ) VALUES
         ($1, $3, $4, 'assistant', 'valid', NULL, NULL, NULL, NULL, NULL),
         ($2, $3, $4, 'assistant', 'invalid newest', NULL, NULL, NULL, NULL, NULL),
         ($5, $3, $4, 'assistant', 'malformed', NULL, NULL, NULL, NULL, NULL),
         ($6, $3, $4, 'assistant', 'inconsistent', NULL, NULL, NULL, NULL, NULL),
         ($7, $3, $4, 'assistant', 'tie', NULL, NULL, NULL, NULL, NULL),
         ($8, $3, $4, 'assistant', 'preserved', 'grounded', 1, 1, 0, 0)`,
      [
        validMessageId,
        noFallbackMessageId,
        conversationId,
        workspaceId,
        malformedMessageId,
        inconsistentMessageId,
        tieMessageId,
        preservedMessageId,
      ],
    );
    const complete = (assistantMessageId: string, verdict = "degraded") => ({
      assistantMessageId,
      groundingVerdict: verdict,
      groundingDiagnostics: { claimCount: 2, sourcedClaimCount: 1, unsourcedClaimCount: 1, invalidSourceCount: 0 },
    });
    const insertEvent = async (type: string, metadata: unknown, createdAt: string) =>
      database.execute(
        `INSERT INTO audit_events (id, account_id, workspace_id, event_type, event_status, metadata_json, created_at)
         VALUES ($1, $2, $3, $4, 'success', $5::jsonb, $6)`,
        [randomUUID(), accountId, workspaceId, type, JSON.stringify(metadata), createdAt],
      );

    await insertEvent("chat.answer", complete(validMessageId, "grounded"), "2026-01-01T00:00:00Z");
    await insertEvent("chat.suspended", complete(validMessageId), "2026-01-01T00:00:01Z");
    await insertEvent("chat.answer", complete(noFallbackMessageId), "2026-01-01T00:00:00Z");
    await insertEvent("chat.suspended", {
      assistantMessageId: noFallbackMessageId,
      groundingVerdict: "degraded",
      groundingDiagnostics: { claimCount: 2, sourcedClaimCount: 1 },
    }, "2026-01-01T00:00:01Z");
    await insertEvent("chat.answer", {
      assistantMessageId: malformedMessageId,
      groundingVerdict: "degraded",
      groundingDiagnostics: { claimCount: 1.5, sourcedClaimCount: -1, unsourcedClaimCount: 2.5, invalidSourceCount: "1" },
    }, "2026-01-01T00:00:02Z");
    await insertEvent("chat.answer", {
      assistantMessageId: inconsistentMessageId,
      groundingVerdict: "degraded",
      groundingDiagnostics: { claimCount: 3, sourcedClaimCount: 1, unsourcedClaimCount: 1, invalidSourceCount: 0 },
    }, "2026-01-01T00:00:02Z");
    await database.execute(
      `INSERT INTO audit_events (id, account_id, workspace_id, event_type, event_status, metadata_json, created_at)
       VALUES
         ('00000000-0000-0000-0000-000000000001', $1, $2, 'chat.answer', 'success', $3::jsonb, '2026-01-01T00:00:03Z'),
         ('ffffffff-ffff-4fff-bfff-ffffffffffff', $1, $2, 'chat.suspended', 'success', $4::jsonb, '2026-01-01T00:00:03Z')`,
      [
        accountId,
        workspaceId,
        JSON.stringify(complete(tieMessageId, "grounded")),
        JSON.stringify(complete(tieMessageId, "no_support")),
      ],
    );
    await insertEvent("chat.answer", complete(preservedMessageId, "degraded"), "2026-01-01T00:00:04Z");

    await applyTestMigration(database, migrationFile);
    const rows = await database.query<{
      id: string;
      grounding_verdict: string | null;
      grounding_claim_count: number | null;
    }>(
      `SELECT id, grounding_verdict, grounding_claim_count
       FROM messages WHERE id = ANY($1::uuid[]) ORDER BY content`,
      [[validMessageId, noFallbackMessageId, malformedMessageId, inconsistentMessageId, tieMessageId, preservedMessageId]],
    );
    expect(rows).toEqual([
      { id: inconsistentMessageId, grounding_verdict: null, grounding_claim_count: null },
      { id: noFallbackMessageId, grounding_verdict: null, grounding_claim_count: null },
      { id: malformedMessageId, grounding_verdict: null, grounding_claim_count: null },
      { id: preservedMessageId, grounding_verdict: "grounded", grounding_claim_count: 1 },
      { id: tieMessageId, grounding_verdict: "no_support", grounding_claim_count: 2 },
      { id: validMessageId, grounding_verdict: "degraded", grounding_claim_count: 2 },
    ]);
  });
});
