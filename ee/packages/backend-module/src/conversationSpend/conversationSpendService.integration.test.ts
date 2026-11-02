import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { UsageLimitDatabasePort } from "../radiosoModuleTypes.js";
import { usageLimitMigrator } from "../usageLimits/usageLimitMigrator.js";
import { ConversationSpendService } from "./conversationSpendService.js";

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

// The OSS tables the migrator references plus the two this read joins: the column subset is the
// one `usage_events` and `conversations` carry in backend/src/db/schema.sql.
const createMinimalBaseSchema = async (database: UsageLimitDatabasePort): Promise<void> => {
  await database.query(`CREATE TABLE users (id UUID PRIMARY KEY, email TEXT NOT NULL UNIQUE)`);
  await database.query(`
    CREATE TABLE accounts (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL DEFAULT 'Account',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await database.query(`
    CREATE TABLE workspaces (
      id UUID PRIMARY KEY,
      account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE
    )
  `);
  await database.query(`
    CREATE TABLE conversations (
      id UUID PRIMARY KEY,
      workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE
    )
  `);
  await database.query(`
    CREATE TABLE usage_events (
      id UUID PRIMARY KEY,
      account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
      workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
      conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
      surface TEXT NOT NULL,
      operation TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens BIGINT NOT NULL DEFAULT 0,
      output_tokens BIGINT NOT NULL DEFAULT 0,
      cached_input_tokens BIGINT,
      status TEXT NOT NULL,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
};

interface SeededEvent {
  conversationId: string | null;
  operation: string;
  provider?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  status?: "succeeded" | "failed";
  occurredAt?: string;
}

describeIfDatabase("conversation spend service", () => {
  let pool: pg.Pool;
  let database: PgDatabase;
  const schema = `ee_test_${randomUUID().replace(/-/g, "")}`;
  const juneMidMonth = "2026-06-15T12:00:00.000Z";

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: integrationDatabaseUrl! });
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
    } finally {
      await admin.end().catch(() => undefined);
    }
    pool = new pg.Pool({ connectionString: integrationDatabaseUrl!, options: `-c search_path=${schema}` });
    database = new PgDatabase(pool);
    await createMinimalBaseSchema(database);
    await usageLimitMigrator.migrate(database);
  });

  beforeEach(async () => {
    await database.query(`TRUNCATE "${schema}".accounts CASCADE`);
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

  const seedAccount = async (profileKey: string | null): Promise<{ accountId: string; workspaceId: string }> => {
    const accountId = randomUUID();
    const workspaceId = randomUUID();
    await database.query(`INSERT INTO accounts (id) VALUES ($1)`, [accountId]);
    await database.query(`INSERT INTO workspaces (id, account_id) VALUES ($1, $2)`, [workspaceId, accountId]);
    if (profileKey) {
      await database.query(
        `INSERT INTO ee_usage_limit_account_assignments (account_id, profile_key) VALUES ($1, $2)`,
        [accountId, profileKey],
      );
    }
    return { accountId, workspaceId };
  };

  const seedConversation = async (
    account: { accountId: string; workspaceId: string },
    meteredReplies: number | null,
    periodStart = "2026-06-01",
  ): Promise<string> => {
    const conversationId = randomUUID();
    await database.query(`INSERT INTO conversations (id, workspace_id) VALUES ($1, $2)`, [conversationId, account.workspaceId]);
    if (meteredReplies !== null) {
      await database.query(
        `INSERT INTO ee_usage_limit_conversation_replies (account_id, period_start, conversation_id, reply_count)
         VALUES ($1, $2::date, $3, $4)`,
        [account.accountId, periodStart, conversationId, meteredReplies],
      );
    }
    return conversationId;
  };

  const seedEvents = async (account: { accountId: string; workspaceId: string }, events: readonly SeededEvent[]) => {
    for (const event of events) {
      await database.query(
        `INSERT INTO usage_events (
           id, account_id, workspace_id, conversation_id, surface, operation, provider, model,
           input_tokens, output_tokens, cached_input_tokens, status, occurred_at
         ) VALUES ($1, $2, $3, $4, 'website_embed', $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          randomUUID(),
          account.accountId,
          account.workspaceId,
          event.conversationId,
          event.operation,
          event.provider ?? "openai",
          event.model,
          event.inputTokens,
          event.outputTokens,
          event.cachedInputTokens ?? null,
          event.status ?? "succeeded",
          event.occurredAt ?? juneMidMonth,
        ],
      );
    }
  };

  // One customer reply: planning and the answer on gpt-5.4-mini, rerank on gpt-5.4-nano, and the
  // query embedding. Half the answer's input is a cached prefix, priced in full all the same.
  //   mini   6,000 in × $0.75/M = $0.0045      400 out × $4.50/M = $0.0018
  //   nano   2,000 in × $0.20/M = $0.0004       50 out × $1.25/M = $0.0000625
  //   embed    100 in × $0.02/M = $0.000002
  //   reply total                                                  $0.0067645
  const replyEvents = (conversationId: string): SeededEvent[] => [
    { conversationId, operation: "turn_planning", model: "gpt-5.4-mini", inputTokens: 2_000, outputTokens: 100 },
    { conversationId, operation: "grounded_answer", model: "gpt-5.4-mini", inputTokens: 4_000, outputTokens: 300, cachedInputTokens: 2_000 },
    { conversationId, operation: "rerank", model: "gpt-5.4-nano", inputTokens: 2_000, outputTokens: 50 },
    { conversationId, operation: "query_embedding", model: "text-embedding-3-small", inputTokens: 100, outputTokens: 0 },
  ];
  // One rolling summary per conversation: 3,000 in → $0.00225, 200 out → $0.0009, $0.00315.
  const summaryEvent = (conversationId: string): SeededEvent => ({
    conversationId,
    operation: "conversation_summary",
    model: "gpt-5.4-mini",
    inputTokens: 3_000,
    outputTokens: 200,
  });

  const seedRepliedConversation = async (account: { accountId: string; workspaceId: string }, replies: number) => {
    const conversationId = await seedConversation(account, replies);
    const events = Array.from({ length: replies }, () => replyEvents(conversationId)).flat();
    await seedEvents(account, [...events, summaryEvent(conversationId)]);
    return conversationId;
  };

  it("matches a hand computation from usage_events and flags an account averaging 8 replies, not one averaging 3", async () => {
    const longAccount = await seedAccount("satellite");
    const shortAccount = await seedAccount("satellite");
    const unmeteredAccount = await seedAccount(null);

    // Two conversations of 8 replies: 16 × $0.0067645 + 2 × $0.00315 = $0.114532
    const longConversation = await seedRepliedConversation(longAccount, 8);
    await seedRepliedConversation(longAccount, 8);
    // Rows that must not count, each in a metered conversation or the same account:
    await seedEvents(longAccount, [
      // a failed call, whose tokens are an estimate the provider never billed
      { conversationId: longConversation, operation: "grounded_answer", model: "gpt-5.4-mini", inputTokens: 50_000, outputTokens: 0, status: "failed" },
      // a call from the same conversation recorded in May, outside the period
      { conversationId: longConversation, operation: "grounded_answer", model: "gpt-5.4-mini", inputTokens: 50_000, outputTokens: 5_000, occurredAt: "2026-05-31T23:59:59.000Z" },
      // work attributed to no conversation (Ray, document enrichment)
      { conversationId: null, operation: "document_enrichment", model: "gpt-5.4-mini", inputTokens: 50_000, outputTokens: 5_000 },
      // a model the catalog has no list price for: counted, not priced
      { conversationId: longConversation, operation: "grounded_answer", provider: "claude", model: "claude-sonnet-5", inputTokens: 50_000, outputTokens: 5_000 },
    ]);
    // A Test Chat conversation: metered as a test run, so it has no reply row.
    const testChatConversation = await seedConversation(longAccount, null);
    await seedEvents(longAccount, replyEvents(testChatConversation));

    // Three conversations of 2, 3 and 4 replies: 9 × $0.0067645 + 3 × $0.00315 = $0.0703305
    await seedRepliedConversation(shortAccount, 2);
    await seedRepliedConversation(shortAccount, 3);
    await seedRepliedConversation(shortAccount, 4);

    const service = new ConversationSpendService(database, { now: () => new Date(juneMidMonth) });
    const spend = await service.listForAccounts([longAccount.accountId, shortAccount.accountId, unmeteredAccount.accountId]);

    // $0.114532 × €0.90 = €0.1030788; / 2 = €0.0515394 → above €0.04
    expect(spend.get(longAccount.accountId)).toEqual({
      periodStart: "2026-06-01",
      meteredConversations: 2,
      spendEur: 0.103079,
      averageEurPerConversation: 0.051539,
      flagAboveEurPerConversation: 0.04,
      flagged: true,
      unpricedCalls: 1,
    });
    // $0.0703305 × €0.90 = €0.06329745; / 3 = €0.02109915 → under €0.04
    expect(spend.get(shortAccount.accountId)).toEqual({
      periodStart: "2026-06-01",
      meteredConversations: 3,
      spendEur: 0.063297,
      averageEurPerConversation: 0.021099,
      flagAboveEurPerConversation: 0.04,
      flagged: false,
      unpricedCalls: 0,
    });
    expect(spend.get(unmeteredAccount.accountId)).toMatchObject({
      meteredConversations: 0,
      spendEur: 0,
      averageEurPerConversation: null,
      flagged: false,
    });
  });

  it("counts one metered conversation per block of the tier's replies, and drops a conversation that was erased", async () => {
    const account = await seedAccount("satellite");
    // 12 replies on a 10-reply tier: replies 1 and 11 each open a block, so two metered conversations.
    const conversationId = await seedConversation(account, 12);
    // 12 × (1,000 in → $0.00075, 100 out → $0.00045) = $0.0144 → €0.01296
    await seedEvents(account, Array.from({ length: 12 }, () => ({
      conversationId,
      operation: "grounded_answer",
      model: "gpt-5.4-mini",
      inputTokens: 1_000,
      outputTokens: 100,
    })));
    // An erased conversation keeps its meter row but loses its spend (usage_events.conversation_id
    // is set null), so it leaves the denominator as well as the numerator.
    const erasedConversation = await seedConversation(account, 5);
    await database.query(`DELETE FROM conversations WHERE id = $1`, [erasedConversation]);
    // Last month's meter row for the same conversation belongs to last month.
    await database.query(
      `INSERT INTO ee_usage_limit_conversation_replies (account_id, period_start, conversation_id, reply_count)
       VALUES ($1, '2026-05-01', $2, 9)`,
      [account.accountId, conversationId],
    );

    const service = new ConversationSpendService(database, { now: () => new Date(juneMidMonth) });
    const spend = await service.listForAccounts([account.accountId]);

    expect(spend.get(account.accountId)).toMatchObject({
      meteredConversations: 2,
      spendEur: 0.01296,
      averageEurPerConversation: 0.00648,
      flagged: false,
    });
  });

  it("reads this month and last month for one account", async () => {
    const account = await seedAccount("satellite");
    const mayConversation = await seedConversation(account, 1, "2026-05-01");
    // 10,000 in → $0.0075, 1,000 out → $0.0045: $0.012 → €0.0108
    await seedEvents(account, [{
      conversationId: mayConversation,
      operation: "grounded_answer",
      model: "gpt-5.4-mini",
      inputTokens: 10_000,
      outputTokens: 1_000,
      occurredAt: "2026-05-20T08:00:00.000Z",
    }]);

    const service = new ConversationSpendService(database, { now: () => new Date(juneMidMonth) });
    const months = await service.getRecentMonths(account.accountId);

    expect(months.current).toMatchObject({ periodStart: "2026-06-01", meteredConversations: 0, averageEurPerConversation: null });
    expect(months.previous).toMatchObject({ periodStart: "2026-05-01", meteredConversations: 1, averageEurPerConversation: 0.0108 });
  });
});
