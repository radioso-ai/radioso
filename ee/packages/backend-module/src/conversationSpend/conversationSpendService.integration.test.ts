import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { UsageLimitDatabasePort } from "../radiosoModuleTypes.js";
import { usageLimitMigrator } from "../usageLimits/usageLimitMigrator.js";
import { EnterpriseUsageLimitService } from "../usageLimits/usageLimitService.js";
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

// The OSS tables the migrator and the meter reference, plus the two the spend read joins: each
// column subset is the one backend/src/db/schema.sql carries.
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
    CREATE TABLE documents (
      id UUID PRIMARY KEY,
      workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      content_size_bytes BIGINT,
      external_document_id TEXT,
      source_kind TEXT
    )
  `);
  await database.query(`
    CREATE TABLE messages (
      id UUID PRIMARY KEY,
      workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
      usage_quality TEXT NOT NULL,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
};

interface SeededAccount {
  accountId: string;
  workspaceId: string;
}

interface SeededEvent {
  conversationId: string | null;
  operation: string;
  provider?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  status?: "succeeded" | "failed";
  usageQuality?: "actual" | "estimated";
  occurredAt?: string;
}

describeIfDatabase("conversation spend service", () => {
  let pool: pg.Pool;
  let database: PgDatabase;
  const schema = `ee_test_${randomUUID().replace(/-/g, "")}`;
  const juneMidMonth = "2026-06-15T12:00:00.000Z";
  const mayMidMonth = "2026-05-15T12:00:00.000Z";

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

  // The real conversation meter, pinned to a month, so meter rows are the ones production writes.
  const meterAt = (instant: string) => new EnterpriseUsageLimitService(database, () => new Date(instant));
  const juneMeter = () => meterAt(juneMidMonth);

  const seedAccount = async (profileKey: string | null): Promise<SeededAccount> => {
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

  const seedConversation = async (account: SeededAccount): Promise<string> => {
    const conversationId = randomUUID();
    await database.query(`INSERT INTO conversations (id, workspace_id) VALUES ($1, $2)`, [conversationId, account.workspaceId]);
    return conversationId;
  };

  /** Reserves `replies` turns through the meter, the way chatService does for a customer channel. */
  const meterReplies = async (
    meter: EnterpriseUsageLimitService,
    account: SeededAccount,
    conversationId: string,
    replies: number,
    usage: "conversation_reply" | "test_run" = "conversation_reply",
  ): Promise<void> => {
    for (let reply = 0; reply < replies; reply += 1) {
      const reservation = await meter.reserveAnswer({
        accountId: account.accountId,
        workspaceId: account.workspaceId,
        surface: usage === "test_run" ? "test_chat" : "website_embed",
        usage,
        conversationId,
      });
      await reservation.commit();
    }
  };

  const meteredConversationUnits = async (account: SeededAccount, meter = juneMeter()): Promise<number | undefined> =>
    (await meter.getAccountUsage(account.accountId)).monthlyConversations?.byKind.conversation;

  const seedEvents = async (account: SeededAccount, events: readonly SeededEvent[]) => {
    for (const event of events) {
      await database.query(
        `INSERT INTO usage_events (
           id, account_id, workspace_id, conversation_id, surface, operation, provider, model,
           input_tokens, output_tokens, cached_input_tokens, status, usage_quality, occurred_at
         ) VALUES ($1, $2, $3, $4, 'website_embed', $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
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
          event.usageQuality ?? "actual",
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
  // A plain gpt-5.4-mini answer: 1,000 in → $0.00075, 100 out → $0.00045, $0.0012.
  const smallAnswer = (conversationId: string, occurredAt = juneMidMonth): SeededEvent => ({
    conversationId,
    operation: "grounded_answer",
    model: "gpt-5.4-mini",
    inputTokens: 1_000,
    outputTokens: 100,
    occurredAt,
  });

  const seedRepliedConversation = async (account: SeededAccount, replies: number) => {
    const conversationId = await seedConversation(account);
    await meterReplies(juneMeter(), account, conversationId, replies);
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
    await seedEvents(longAccount, [
      // Counted: a reply stream the visitor interrupted, recorded `failed` with the tokens the
      // provider reported and billed. +$0.0012
      { ...smallAnswer(longConversation), status: "failed", usageQuality: "actual" },
      // Not counted: a failed call with no provider-reported usage, whose tokens are an estimate
      // from the request size
      { conversationId: longConversation, operation: "grounded_answer", model: "gpt-5.4-mini", inputTokens: 50_000, outputTokens: 0, status: "failed", usageQuality: "estimated" },
      // Not counted: the same conversation in May, outside the period
      { ...smallAnswer(longConversation, "2026-05-31T23:59:59.000Z"), inputTokens: 50_000 },
      // Not counted: work attributed to no conversation (Ray, document enrichment)
      { conversationId: null, operation: "document_enrichment", model: "gpt-5.4-mini", inputTokens: 50_000, outputTokens: 5_000 },
      // Counted, not priced: a model the catalog has no list price for
      { conversationId: longConversation, operation: "grounded_answer", provider: "claude", model: "claude-sonnet-5", inputTokens: 50_000, outputTokens: 5_000 },
    ]);
    // A Test Chat conversation meters as a test run, so the conversation meter never sees it.
    const testChatConversation = await seedConversation(longAccount);
    await meterReplies(juneMeter(), longAccount, testChatConversation, 2, "test_run");
    await seedEvents(longAccount, replyEvents(testChatConversation));

    // Three conversations of 2, 3 and 4 replies: 9 × $0.0067645 + 3 × $0.00315 = $0.0703305
    await seedRepliedConversation(shortAccount, 2);
    await seedRepliedConversation(shortAccount, 3);
    await seedRepliedConversation(shortAccount, 4);

    const service = new ConversationSpendService(database, { now: () => new Date(juneMidMonth) });
    const spend = await service.listForAccounts([longAccount.accountId, shortAccount.accountId, unmeteredAccount.accountId]);

    // $0.115732 × €0.90 = €0.1041588; / 2 = €0.0520794 → above €0.04. The unpriced call can only
    // add to that, so the flag is settled.
    expect(spend.get(longAccount.accountId)).toEqual({
      periodStart: "2026-06-01",
      repliesPerConversation: 10,
      meteredConversations: 2,
      spendEur: 0.104159,
      averageEurPerConversation: 0.052079,
      flagAboveEurPerConversation: 0.04,
      flag: "above",
      unpricedCalls: 1,
    });
    // $0.0703305 × €0.90 = €0.06329745; / 3 = €0.02109915 → under €0.04
    expect(spend.get(shortAccount.accountId)).toEqual({
      periodStart: "2026-06-01",
      repliesPerConversation: 10,
      meteredConversations: 3,
      spendEur: 0.063297,
      averageEurPerConversation: 0.021099,
      flagAboveEurPerConversation: 0.04,
      flag: "below",
      unpricedCalls: 0,
    });
    expect(spend.get(unmeteredAccount.accountId)).toMatchObject({
      meteredConversations: 0,
      spendEur: 0,
      averageEurPerConversation: null,
      flag: "none",
    });
    // With the tier unchanged all month, the denominator is what the meter charged.
    expect(await meteredConversationUnits(longAccount)).toBe(2);
    expect(await meteredConversationUnits(shortAccount)).toBe(3);
  });

  it("counts one metered conversation per block of the tier's replies, and drops a conversation that was erased", async () => {
    const account = await seedAccount("satellite");
    // 12 replies on a 10-reply tier: the meter charges replies 1 and 11, so two conversations.
    const conversationId = await seedConversation(account);
    await meterReplies(juneMeter(), account, conversationId, 12);
    // 12 × $0.0012 = $0.0144 → €0.01296
    await seedEvents(account, Array.from({ length: 12 }, () => smallAnswer(conversationId)));
    expect(await meteredConversationUnits(account)).toBe(2);

    // An erased conversation keeps its meter row and its charge, but its ledger rows lose their
    // conversation link, so it leaves the denominator along with its spend.
    const erasedConversation = await seedConversation(account);
    await meterReplies(juneMeter(), account, erasedConversation, 5);
    await database.query(`DELETE FROM conversations WHERE id = $1`, [erasedConversation]);
    expect(await meteredConversationUnits(account)).toBe(3);

    // The same conversation's May replies are May's meter row, not June's.
    await meterReplies(meterAt(mayMidMonth), account, conversationId, 9);

    const service = new ConversationSpendService(database, { now: () => new Date(juneMidMonth) });
    const spend = await service.listForAccounts([account.accountId]);

    expect(spend.get(account.accountId)).toMatchObject({
      meteredConversations: 2,
      spendEur: 0.01296,
      averageEurPerConversation: 0.00648,
      flag: "below",
    });
  });

  it("counts both months at the tier's current replies per conversation, so changing it re-bases last month too", async () => {
    const tierKey = "spend_test_tier";
    await juneMeter().upsertProfile({
      key: tierKey,
      displayName: "Spend test tier",
      monthlyAnswerLimit: null,
      storedDocumentLimit: null,
      monthlyConversationLimit: 1000,
      repliesPerConversation: 10,
    });
    const account = await seedAccount(tierKey);
    // One 8-reply conversation in each month, each reply a $0.0012 answer: $0.0096 → €0.00864.
    const mayConversation = await seedConversation(account);
    await meterReplies(meterAt(mayMidMonth), account, mayConversation, 8);
    await seedEvents(account, Array.from({ length: 8 }, () => smallAnswer(mayConversation, mayMidMonth)));
    const juneConversation = await seedConversation(account);
    await meterReplies(juneMeter(), account, juneConversation, 8);
    await seedEvents(account, Array.from({ length: 8 }, () => smallAnswer(juneConversation)));

    const service = new ConversationSpendService(database, { now: () => new Date(juneMidMonth) });
    const before = await service.getRecentMonths(account.accountId);
    expect(before.current).toMatchObject({ periodStart: "2026-06-01", repliesPerConversation: 10, meteredConversations: 1, averageEurPerConversation: 0.00864 });
    expect(before.previous).toMatchObject({ periodStart: "2026-05-01", repliesPerConversation: 10, meteredConversations: 1, averageEurPerConversation: 0.00864 });

    // Staff lower the tier to 6 replies per conversation. The meter charged each 8-reply
    // conversation once, under 10, but both months now read at 6: two each, half the average.
    await juneMeter().upsertProfile({
      key: tierKey,
      displayName: "Spend test tier",
      monthlyAnswerLimit: null,
      storedDocumentLimit: null,
      repliesPerConversation: 6,
    });
    const after = await service.getRecentMonths(account.accountId);
    expect(after.current).toMatchObject({ repliesPerConversation: 6, meteredConversations: 2, averageEurPerConversation: 0.00432 });
    expect(after.previous).toMatchObject({ repliesPerConversation: 6, meteredConversations: 2, averageEurPerConversation: 0.00432 });
    expect(await meteredConversationUnits(account)).toBe(1);
  });
});
