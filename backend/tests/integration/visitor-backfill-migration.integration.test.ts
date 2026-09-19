import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Database } from "../../src/shared/infra/database.js";
import {
  applyTestMigration,
  runTestMigrationsBefore,
} from "../support/databaseMigrations.js";

// Pins a fresh database to the schema exactly as it existed before migration 192, seeds
// conversations the way years of production data would look, then applies 192 and asserts
// the backfill (FR-002) and the request-facts / CHECK-widening DDL (FR-001/010/030).
//
// Needs CREATE DATABASE on the integration server; skips cleanly when no database is reachable.
const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;
const migration192 = "192_visitors.sql";

const canCreateIsolatedDatabase = async (databaseUrl?: string): Promise<boolean> => {
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

const hasReachableDatabase = await canCreateIsolatedDatabase(integrationDatabaseUrl);
const describeIfDatabase = hasReachableDatabase ? describe : describe.skip;

describeIfDatabase("visitors backfill migration (192)", () => {
  const isolatedName = `mig192_${randomUUID().replace(/-/g, "")}`;
  let admin: Database;
  let database: Database;

  beforeAll(async () => {
    admin = new Database(integrationDatabaseUrl!);
    await admin.execute(`CREATE DATABASE "${isolatedName}"`);
    database = new Database(isolatedDatabaseUrl(integrationDatabaseUrl!, isolatedName));
    await runTestMigrationsBefore(database, migration192);
  });

  afterAll(async () => {
    await database?.close().catch(() => undefined);
    if (admin) {
      await admin.execute(`DROP DATABASE IF EXISTS "${isolatedName}" WITH (FORCE)`).catch(() => undefined);
      await admin.close().catch(() => undefined);
    }
  });

  it("backfills one visitor per key, links eligible conversations, and leaves ineligible ones null", async () => {
    const accountId = randomUUID();
    const workspaceId = randomUUID();
    const agentId = randomUUID();

    await database.execute(
      "INSERT INTO accounts(id, name, email, password_hash) VALUES ($1, 'Acct', $2, 'hash')",
      [accountId, `mig192-${accountId}@example.com`],
    );
    await database.execute(
      "INSERT INTO workspaces(id, account_id, name, public_route_key) VALUES ($1, $2, 'WS', $3)",
      [workspaceId, accountId, `rk-${workspaceId}`],
    );
    await database.execute(
      "INSERT INTO agents(id, workspace_id, name) VALUES ($1, $2, 'Agent')",
      [agentId, workspaceId],
    );

    const insertConversation = async (input: {
      purpose: string;
      sourceChannel: string | null;
      anonymousSessionId: string | null;
      verifiedCustomerId: string | null;
      createdAt: string;
    }) => {
      const id = randomUUID();
      await database.execute(
        `INSERT INTO conversations
           (id, workspace_id, agent_id, purpose, source_channel, anonymous_session_id, verified_customer_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $8::timestamptz)`,
        [
          id,
          workspaceId,
          agentId,
          input.purpose,
          input.sourceChannel,
          input.anonymousSessionId,
          input.verifiedCustomerId,
          input.createdAt,
        ],
      );
      return id;
    };

    // Two conversations for the same anonymous id, never verified: should backfill to one
    // visitor with conversation_count 2 and first/last seen spanning both.
    const anonOnly1 = await insertConversation({
      purpose: "production",
      sourceChannel: "website_embed",
      anonymousSessionId: "anon-only",
      verifiedCustomerId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const anonOnly2 = await insertConversation({
      purpose: "production",
      sourceChannel: "website_embed",
      anonymousSessionId: "anon-only",
      verifiedCustomerId: null,
      createdAt: "2026-01-02T00:00:00.000Z",
    });

    // Anonymous id that was later verified: one conversation carries only the anonymous id,
    // a second carries both. Per FR-002 this backfills as a single verified visitor keyed by
    // the verified id, not a separate anonymous-only visitor.
    const upgradedAnonOnly = await insertConversation({
      purpose: "production",
      sourceChannel: "website_embed",
      anonymousSessionId: "anon-upgraded",
      verifiedCustomerId: null,
      createdAt: "2026-01-03T00:00:00.000Z",
    });
    const upgradedVerified = await insertConversation({
      purpose: "production",
      sourceChannel: "website_embed",
      anonymousSessionId: "anon-upgraded",
      verifiedCustomerId: "customer-upgraded",
      createdAt: "2026-01-04T00:00:00.000Z",
    });

    // Operator-test conversation with both keys populated: must never get a visitor (FR-005).
    const operatorTest = await insertConversation({
      purpose: "operator_test",
      sourceChannel: "authenticated_chat",
      anonymousSessionId: "anon-operator-test",
      verifiedCustomerId: "customer-operator-test",
      createdAt: "2026-01-05T00:00:00.000Z",
    });

    // Neither key (Slack/MCP-shaped): stays visitor_id null.
    const neitherKey = await insertConversation({
      purpose: "production",
      sourceChannel: "slack",
      anonymousSessionId: null,
      verifiedCustomerId: null,
      createdAt: "2026-01-06T00:00:00.000Z",
    });

    await expect(applyTestMigration(database, migration192)).resolves.not.toThrow();

    const anonOnlyVisitor = await database.query<{
      id: string;
      conversation_count: number;
      first_seen_at: Date;
      last_seen_at: Date;
      verified_customer_id: string | null;
    }>(
      "SELECT id, conversation_count, first_seen_at, last_seen_at, verified_customer_id FROM visitors WHERE workspace_id = $1 AND visitor_key = $2",
      [workspaceId, "anon-only"],
    );
    expect(anonOnlyVisitor).toHaveLength(1);
    expect(Number(anonOnlyVisitor[0].conversation_count)).toBe(2);
    expect(anonOnlyVisitor[0].verified_customer_id).toBeNull();
    expect(new Date(anonOnlyVisitor[0].first_seen_at).toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(new Date(anonOnlyVisitor[0].last_seen_at).toISOString()).toBe("2026-01-02T00:00:00.000Z");

    const upgradedVisitor = await database.query<{
      id: string;
      conversation_count: number;
      first_seen_at: Date;
      last_seen_at: Date;
      visitor_key: string | null;
    }>(
      "SELECT id, conversation_count, first_seen_at, last_seen_at, visitor_key FROM visitors WHERE workspace_id = $1 AND verified_customer_id = $2",
      [workspaceId, "customer-upgraded"],
    );
    expect(upgradedVisitor).toHaveLength(1);
    // Both the pre-verification anonymous-only conversation and the later verified one
    // count toward this single visitor — the "one visitor, three conversations" shape.
    expect(Number(upgradedVisitor[0].conversation_count)).toBe(2);
    expect(new Date(upgradedVisitor[0].first_seen_at).toISOString()).toBe("2026-01-03T00:00:00.000Z");
    expect(new Date(upgradedVisitor[0].last_seen_at).toISOString()).toBe("2026-01-04T00:00:00.000Z");
    // No separate anonymous-keyed visitor was created for the anon id that was later verified.
    const strandedAnonVisitor = await database.query(
      "SELECT id FROM visitors WHERE workspace_id = $1 AND visitor_key = $2",
      [workspaceId, "anon-upgraded"],
    );
    expect(strandedAnonVisitor).toHaveLength(0);

    const conversationVisitorIds = await database.query<{ id: string; visitor_id: string | null }>(
      "SELECT id, visitor_id FROM conversations WHERE workspace_id = $1",
      [workspaceId],
    );
    const byId = new Map(conversationVisitorIds.map((row) => [row.id, row.visitor_id]));
    expect(byId.get(anonOnly1)).toBe(anonOnlyVisitor[0].id);
    expect(byId.get(anonOnly2)).toBe(anonOnlyVisitor[0].id);
    // The pre-verification anonymous-only conversation resolves to the SAME verified
    // visitor as its later-verified sibling — the "one visitor, three conversations"
    // backfill shape, not a stranded anonymous-only visitor.
    expect(byId.get(upgradedAnonOnly)).toBe(upgradedVisitor[0].id);
    expect(byId.get(upgradedVerified)).toBe(upgradedVisitor[0].id);
    expect(byId.get(operatorTest)).toBeNull();
    expect(byId.get(neitherKey)).toBeNull();
  });

  it("ON DELETE SET NULL: deleting a visitor row clears the conversation's visitor_id instead of blocking the delete", async () => {
    // Depends on the previous test having already applied migration 192 to this shared,
    // isolated database — applying it twice would re-run the (non-idempotent) backfill
    // INSERTs against the rows that test seeded and collide with the unique indexes.
    const accountId = randomUUID();
    const workspaceId = randomUUID();
    const agentId = randomUUID();
    await database.execute(
      "INSERT INTO accounts(id, name, email, password_hash) VALUES ($1, 'Acct2', $2, 'hash')",
      [accountId, `mig192b-${accountId}@example.com`],
    );
    await database.execute(
      "INSERT INTO workspaces(id, account_id, name, public_route_key) VALUES ($1, $2, 'WS2', $3)",
      [workspaceId, accountId, `rk2-${workspaceId}`],
    );
    await database.execute(
      "INSERT INTO agents(id, workspace_id, name) VALUES ($1, $2, 'Agent2')",
      [agentId, workspaceId],
    );
    const visitorId = randomUUID();
    await database.execute(
      "INSERT INTO visitors(id, workspace_id, visitor_key) VALUES ($1, $2, 'anon-delete-me')",
      [visitorId, workspaceId],
    );
    const conversationId = randomUUID();
    await database.execute(
      "INSERT INTO conversations(id, workspace_id, agent_id, purpose, visitor_id) VALUES ($1, $2, $3, 'production', $4)",
      [conversationId, workspaceId, agentId, visitorId],
    );

    await database.execute("DELETE FROM visitors WHERE id = $1", [visitorId]);

    const [row] = await database.query<{ visitor_id: string | null }>(
      "SELECT visitor_id FROM conversations WHERE id = $1",
      [conversationId],
    );
    expect(row.visitor_id).toBeNull();
  });

  it("widens the agent_context_variables.source CHECK to accept 'request'", async () => {
    // Also depends on migration 192 already having been applied by the first test in this
    // file (see note above) — this test only exercises the widened CHECK, not the backfill.
    const accountId = randomUUID();
    const workspaceId = randomUUID();
    const agentId = randomUUID();
    await database.execute(
      "INSERT INTO accounts(id, name, email, password_hash) VALUES ($1, 'Acct3', $2, 'hash')",
      [accountId, `mig192c-${accountId}@example.com`],
    );
    await database.execute(
      "INSERT INTO workspaces(id, account_id, name, public_route_key) VALUES ($1, $2, 'WS3', $3)",
      [workspaceId, accountId, `rk3-${workspaceId}`],
    );
    await database.execute(
      "INSERT INTO agents(id, workspace_id, name) VALUES ($1, $2, 'Agent3')",
      [agentId, workspaceId],
    );
    const variableId = randomUUID();
    await database.execute(
      `INSERT INTO context_variables(id, workspace_id, name, value_type, trust_tier, sensitivity, default_surfacing)
       VALUES ($1, $2, 'visitor_request', 'json', 'unverified', 'normal', 'always')`,
      [variableId, workspaceId],
    );

    await expect(
      database.execute(
        `INSERT INTO agent_context_variables(agent_id, variable_id, source, surfacing)
         VALUES ($1, $2, 'request', 'always')`,
        [agentId, variableId],
      ),
    ).resolves.not.toThrow();

    await expect(
      database.execute(
        `INSERT INTO agent_context_variables(agent_id, variable_id, source, surfacing)
         VALUES ($1, $2, 'not_a_real_source', 'always')`,
        [randomUUID(), randomUUID()],
      ),
    ).rejects.toThrow();
  });
});
