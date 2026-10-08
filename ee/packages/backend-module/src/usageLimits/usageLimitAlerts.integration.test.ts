import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EnterpriseUsageLimitService } from "./usageLimitService.js";
import { UsageLimitExceededError } from "./errors.js";
import { usageLimitMigrator } from "./usageLimitMigrator.js";
import { currentPeriodStart } from "./period.js";
import type { UsageLimitDatabasePort } from "../radiosoModuleTypes.js";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const canReachIntegrationDatabase = async (databaseUrl?: string): Promise<boolean> => {
  if (!databaseUrl) {
    return false;
  }
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await pool.end().catch(() => undefined);
  }
};

class PgDatabase implements UsageLimitDatabasePort {
  constructor(readonly pool: pg.Pool) {}

  async query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> {
    const result = await this.pool.query(text, params);
    return result.rows as T[];
  }
}

const hasReachableIntegrationDatabase = await canReachIntegrationDatabase(integrationDatabaseUrl);
const describeIfDatabase = hasReachableIntegrationDatabase ? describe : describe.skip;

const createMinimalBaseSchema = async (database: UsageLimitDatabasePort): Promise<void> => {
  await database.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      email_verified_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await database.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL DEFAULT 'Integration Account',
      email TEXT NOT NULL DEFAULT 'integration@example.com',
      password_hash TEXT NOT NULL DEFAULT 'hash',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await database.query(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id UUID PRIMARY KEY,
      account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT 'Integration Workspace',
      public_route_key TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await database.query(`
    CREATE TABLE IF NOT EXISTS documents (
      id UUID PRIMARY KEY,
      workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      content_size_bytes BIGINT,
      external_document_id TEXT,
      source_kind TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await database.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id UUID PRIMARY KEY,
      workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
};

describeIfDatabase("EE usage limit alert claims", () => {
  let pool: pg.Pool;
  let database: PgDatabase;
  const schema = `ee_test_alerts_${randomUUID().replace(/-/g, "")}`;

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: integrationDatabaseUrl! });
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
    } finally {
      await admin.end().catch(() => undefined);
    }
    pool = new pg.Pool({
      connectionString: integrationDatabaseUrl!,
      options: `-c search_path=${schema}`,
    });
    database = new PgDatabase(pool);
    await createMinimalBaseSchema(database);
    await usageLimitMigrator.migrate(database);
  });

  afterAll(async () => {
    await pool.end();
    const admin = new pg.Pool({ connectionString: integrationDatabaseUrl! });
    try {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await admin.end().catch(() => undefined);
    }
  });

  const seedAccountWorkspace = async (): Promise<{ accountId: string; workspaceId: string }> => {
    const accountId = randomUUID();
    const workspaceId = randomUUID();
    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, 'hash') ON CONFLICT (id) DO NOTHING`,
      [accountId, "Alert Integration Account", `alerts-${accountId}@example.com`],
    );
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
      [workspaceId, accountId, "Alert Integration Workspace", `alerts-route-${workspaceId}`],
    );
    return { accountId, workspaceId };
  };

  const assignProfile = async (
    accountId: string,
    limits: { monthlyConversationLimit: number | null; repliesPerConversation?: number },
  ): Promise<string> => {
    const service = new EnterpriseUsageLimitService(database);
    const key = `it_alerts_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await service.upsertProfile({
      key,
      displayName: "Alert Integration Profile",
      monthlyAnswerLimit: null,
      storedDocumentLimit: null,
      monthlyConversationLimit: limits.monthlyConversationLimit,
      repliesPerConversation: limits.repliesPerConversation,
    });
    await service.assignProfile(accountId, key);
    return key;
  };

  const readClaims = async (accountId: string): Promise<Array<{
    level: string;
    sent_at: Date | null;
    outcome: string | null;
    attempts: number;
  }>> => {
    return database.query<{ level: string; sent_at: Date | null; outcome: string | null; attempts: number }>(
      `SELECT level, sent_at, outcome, attempts FROM ee_usage_limit_alerts
       WHERE account_id = $1 AND period_start = $2::date
       ORDER BY level`,
      [accountId, currentPeriodStart()],
    );
  };

  it("claims nearing_limit once a reservation crosses 80% of capacity, and is idempotent on a later call that stays at the same level", async () => {
    const { accountId, workspaceId } = await seedAccountWorkspace();
    // limit 10 conversations: the 8th whole conversation (80%) crosses into nearing_limit.
    await assignProfile(accountId, { monthlyConversationLimit: 10 });
    const service = new EnterpriseUsageLimitService(database);
    const reserveConversation = () => service.reserveAnswer({
      accountId, workspaceId, surface: "agent_api", usage: "conversation_reply", conversationId: randomUUID(),
    });

    for (let i = 0; i < 7; i += 1) {
      await reserveConversation();
    }
    expect(await readClaims(accountId)).toEqual([]);

    await reserveConversation();
    const afterEighth = await readClaims(accountId);
    expect(afterEighth).toEqual([
      expect.objectContaining({ level: "nearing_limit", sent_at: null, outcome: null, attempts: 0 }),
    ]);

    // A later call at the same level (still nearing_limit, not yet limit_reached) must not
    // insert a second claim or error on the conflict.
    await reserveConversation();
    expect(await readClaims(accountId)).toEqual([
      expect.objectContaining({ level: "nearing_limit" }),
    ]);
  });

  it("claims every level crossed by a single reservation that jumps straight through them", async () => {
    const { accountId, workspaceId } = await seedAccountWorkspace();
    // limit 1 conversation: grace floor(1 * 0.1) = 0, so the very first conversation already
    // lands on grace_exhausted in one commit, crossing nearing_limit and limit_reached too.
    await assignProfile(accountId, { monthlyConversationLimit: 1 });
    const service = new EnterpriseUsageLimitService(database);

    await service.reserveAnswer({
      accountId, workspaceId, surface: "agent_api", usage: "conversation_reply", conversationId: randomUUID(),
    });

    const claims = await readClaims(accountId);
    expect(claims.map((claim) => claim.level)).toEqual(["grace_exhausted", "limit_reached", "nearing_limit"]);
    expect(claims.every((claim) => claim.sent_at === null)).toBe(true);
  });

  it("claims grace_exhausted when a conversation reservation is refused outright, even though nothing commits", async () => {
    const { accountId, workspaceId } = await seedAccountWorkspace();
    // limit 0: the first conversation reservation attempt overshoots past a zero grace
    // ceiling and is refused before anything is ever committed for this account.
    await assignProfile(accountId, { monthlyConversationLimit: 0 });
    const service = new EnterpriseUsageLimitService(database);

    await expect(service.reserveAnswer({
      accountId, workspaceId, surface: "agent_api", usage: "conversation_reply", conversationId: randomUUID(),
    })).rejects.toBeInstanceOf(UsageLimitExceededError);

    const claims = await readClaims(accountId);
    expect(claims).toEqual([
      expect.objectContaining({ level: "grace_exhausted", sent_at: null, outcome: null }),
    ]);
  });

  it("never claims grace_exhausted for a refused non-conversation (internal) reservation", async () => {
    const { accountId, workspaceId } = await seedAccountWorkspace();
    await assignProfile(accountId, { monthlyConversationLimit: 0 });
    const service = new EnterpriseUsageLimitService(database);

    await expect(service.reserveAnswer({ accountId, workspaceId, surface: "operator_copilot", usage: "copilot_turn" }))
      .rejects.toBeInstanceOf(UsageLimitExceededError);

    expect(await readClaims(accountId)).toEqual([]);
  });

  it("re-arms on a credit grant that actually applies: a burned-again top-up alerts again", async () => {
    const { accountId, workspaceId } = await seedAccountWorkspace();
    await assignProfile(accountId, { monthlyConversationLimit: 1 });
    const service = new EnterpriseUsageLimitService(database);

    await service.reserveAnswer({
      accountId, workspaceId, surface: "agent_api", usage: "conversation_reply", conversationId: randomUUID(),
    });
    expect((await readClaims(accountId)).length).toBeGreaterThan(0);

    // A duplicate (already-applied) reference must not re-arm: nothing new was granted.
    await service.addCredits({ accountId, conversations: 1, reference: "dup-ref" });
    await service.addCredits({ accountId, conversations: 1, reference: "dup-ref" });

    // The second call reused the same reference and did not apply, so the first grant's
    // re-arm already cleared the claims — assert they are gone exactly once, not reset twice.
    expect(await readClaims(accountId)).toEqual([]);

    // Burn the grace again; the alert claims again under the same period.
    await service.reserveAnswer({
      accountId, workspaceId, surface: "agent_api", usage: "conversation_reply", conversationId: randomUUID(),
    });
    expect((await readClaims(accountId)).length).toBeGreaterThan(0);
  });

  it("re-arms when the account is assigned a different profile", async () => {
    const { accountId, workspaceId } = await seedAccountWorkspace();
    await assignProfile(accountId, { monthlyConversationLimit: 1 });
    const service = new EnterpriseUsageLimitService(database);

    await service.reserveAnswer({
      accountId, workspaceId, surface: "agent_api", usage: "conversation_reply", conversationId: randomUUID(),
    });
    expect((await readClaims(accountId)).length).toBeGreaterThan(0);

    await assignProfile(accountId, { monthlyConversationLimit: 100 });
    expect(await readClaims(accountId)).toEqual([]);
  });
});
