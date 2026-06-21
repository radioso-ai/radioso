import { randomUUID } from "node:crypto";

import { beforeAll, afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { AgentRepository } from "../../src/db/repositories/agentRepository.js";
import { WorkspaceRepository } from "../../src/db/repositories/workspaceRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { UsageTrendsService } from "../../src/modules/reporting/service.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";
import { createAuditService, InMemoryAccountMembershipRepository } from "../support/fakes.js";
import { AccountAccessService } from "../../src/modules/account/services/accountAccessService.js";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

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

const hasReachableIntegrationDatabase = await canReachIntegrationDatabase(integrationDatabaseUrl);
const describeIfDatabase = hasReachableIntegrationDatabase ? describe : describe.skip;

describeIfDatabase("usage trends integration", () => {
  let database: Database;
  let accountRepository: AccountRepository;
  let workspaceRepository: WorkspaceRepository;
  let agentRepository: AgentRepository;
  const accountIds: string[] = [];

  beforeAll(async () => {
    database = new Database(integrationDatabaseUrl!);
    accountRepository = new AccountRepository(database.kysely);
    workspaceRepository = new WorkspaceRepository(database);
    agentRepository = new AgentRepository(database);
    await runAllTestMigrations(database);
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.query("DELETE FROM usage_events WHERE idempotency_key LIKE 'usage-trends-test-%'");
  });

  afterEach(async () => {
    while (accountIds.length > 0) {
      const accountId = accountIds.pop()!;
      await database.query("DELETE FROM accounts WHERE id = $1", [accountId]);
    }
  });

  it("keeps daily, weekly, and monthly totals internally consistent and narrows by agent", async () => {
    const account = await accountRepository.create({
      email: `usage-trends-${randomUUID()}@example.com`,
      name: "Usage Trends",
      passwordHash: "hash",
    });
    accountIds.push(account.id);
    const workspace = await workspaceRepository.create(account.id, "Usage Workspace");
    const agentA = await agentRepository.create(workspace.id, { name: "Agent A" });
    const agentB = await agentRepository.create(workspace.id, { name: "Agent B" });
    const userId = randomUUID();
    const membershipRepository = new InMemoryAccountMembershipRepository();
    await membershipRepository.create({ accountId: account.id, userId, role: "member" });
    const service = new UsageTrendsService(database, new AccountAccessService(membershipRepository, createAuditService()));

    const conversationA = randomUUID();
    const conversationB = randomUUID();
    await database.query(
      `INSERT INTO conversations (id, workspace_id, agent_id, source_channel, created_at, updated_at)
       VALUES ($1, $2, $3, 'dashboard', '2026-06-01T10:00:00Z', '2026-06-01T10:00:00Z'),
              ($4, $2, $5, 'dashboard', '2026-06-03T10:00:00Z', '2026-06-03T10:00:00Z')`,
      [conversationA, workspace.id, agentA.id, conversationB, agentB.id],
    );
    await database.query(
      `INSERT INTO messages (id, conversation_id, workspace_id, role, content, created_at)
       VALUES ($1, $2, $3, 'user', 'hidden', '2026-06-01T10:01:00Z'),
              ($4, $2, $3, 'assistant', 'hidden', '2026-06-01T10:02:00Z'),
              ($5, $6, $3, 'user', 'hidden', '2026-06-03T10:01:00Z')`,
      [randomUUID(), conversationA, workspace.id, randomUUID(), randomUUID(), conversationB],
    );
    await database.query(
      `INSERT INTO usage_events (
         id, idempotency_key, account_id, workspace_id, conversation_id, surface, operation, provider, model,
         input_tokens, output_tokens, total_tokens, status, usage_quality, occurred_at
       )
       VALUES
         ($1, $2, $3, $4, $5, 'chat', 'answer', 'test', 'test', 10, 20, 30, 'succeeded', 'exact', '2026-06-01T10:03:00Z'),
         ($6, $7, $3, $4, $8, 'chat', 'answer', 'test', 'test', 5, 7, 12, 'succeeded', 'exact', '2026-06-03T10:03:00Z'),
         ($9, $10, $3, $4, NULL, 'chat', 'answer', 'test', 'test', 100, 100, 200, 'succeeded', 'exact', '2026-06-03T10:04:00Z'),
         ($11, $12, $3, $4, $5, 'chat', 'answer', 'test', 'test', 99, 99, 198, 'failed', 'exact', '2026-06-01T10:05:00Z')`,
      [
        randomUUID(),
        `usage-trends-test-${randomUUID()}`,
        account.id,
        workspace.id,
        conversationA,
        randomUUID(),
        `usage-trends-test-${randomUUID()}`,
        conversationB,
        randomUUID(),
        `usage-trends-test-${randomUUID()}`,
        randomUUID(),
        `usage-trends-test-${randomUUID()}`,
      ],
    );

    const daily = await service.getUsageTrends({ accountId: account.id, userId, from: "2026-06-01", to: "2026-06-30", granularity: "day" });
    const weekly = await service.getUsageTrends({ accountId: account.id, userId, from: "2026-06-01", to: "2026-06-30", granularity: "week" });
    const monthly = await service.getUsageTrends({ accountId: account.id, userId, from: "2026-06-01", to: "2026-06-30", granularity: "month" });
    const agentFiltered = await service.getUsageTrends({
      accountId: account.id,
      userId,
      from: "2026-06-01",
      to: "2026-06-30",
      granularity: "month",
      agentId: agentA.id,
    });

    const dailyTotal = daily.buckets.reduce((sum, bucket) => sum + bucket.tokens.total, 0);
    expect(dailyTotal).toBe(242);
    expect(weekly.buckets.reduce((sum, bucket) => sum + bucket.tokens.total, 0)).toBe(dailyTotal);
    expect(monthly.buckets[0]?.tokens.total).toBe(dailyTotal);
    expect(agentFiltered.buckets[0]).toMatchObject({
      conversationsCreated: 1,
      messages: { total: 2, user: 1, assistant: 1 },
      tokens: { input: 10, output: 20, total: 30 },
    });
  });
});
