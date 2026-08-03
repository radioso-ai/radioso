import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { AgentRepository } from "../../src/db/repositories/agentRepository.js";
import { UsageDetailsReportingRepository } from "../../src/db/repositories/usageDetailsReportingRepository.js";
import { WorkspaceRepository } from "../../src/db/repositories/workspaceRepository.js";
import { UsageDetailsService } from "../../src/modules/reporting/service.js";
import { Database } from "../../src/shared/infra/database.js";
import { AccountAccessService } from "../../src/modules/account/services/accountAccessService.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";
import { createAuditService, InMemoryAccountMembershipRepository } from "../support/fakes.js";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const canReachIntegrationDatabase = async (databaseUrl?: string): Promise<boolean> => {
  if (!databaseUrl) return false;
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

const describeIfDatabase = await canReachIntegrationDatabase(integrationDatabaseUrl) ? describe : describe.skip;

describeIfDatabase("usage details integration", () => {
  let database: Database;
  let accountRepository: AccountRepository;
  let workspaceRepository: WorkspaceRepository;
  let agentRepository: AgentRepository;
  const accountIds: string[] = [];

  beforeAll(async () => {
    database = new Database(integrationDatabaseUrl!);
    accountRepository = new AccountRepository(database.kysely);
    workspaceRepository = new WorkspaceRepository(database.kysely);
    agentRepository = new AgentRepository(database.kysely);
    await runAllTestMigrations(database);
  });

  beforeEach(async () => {
    await database.query("DELETE FROM usage_events WHERE idempotency_key LIKE 'usage-details-test-%'");
  });

  afterEach(async () => {
    while (accountIds.length > 0) {
      await database.query("DELETE FROM accounts WHERE id = $1", [accountIds.pop()!]);
    }
  });

  afterAll(async () => {
    await database.close();
  });

  const createService = async () => {
    const account = await accountRepository.create({
      email: `usage-details-${randomUUID()}@example.com`,
      name: "Usage Details",
      passwordHash: "hash",
    });
    accountIds.push(account.id);
    const workspace = await workspaceRepository.create(account.id, "Usage Details Workspace");
    const agent = await agentRepository.create(workspace.id, { name: "Usage Details Agent" });
    const userId = randomUUID();
    const membershipRepository = new InMemoryAccountMembershipRepository();
    await membershipRepository.create({ accountId: account.id, userId, role: "member" });
    const service = new UsageDetailsService(
      new UsageDetailsReportingRepository(database.kysely),
      new AccountAccessService(membershipRepository, createAuditService()),
    );
    return { account, workspace, agent, userId, service };
  };

  it("keeps embedding usage separate when a visitor message has partial model reasoning coverage", async () => {
    const { account, workspace, agent, userId, service } = await createService();
    const conversationId = randomUUID();
    const messageId = randomUUID();
    await database.query(
      `INSERT INTO conversations (id, workspace_id, agent_id, source_channel, created_at, updated_at)
       VALUES ($1, $2, $3, 'dashboard', '2026-07-10T10:00:00Z', '2026-07-10T10:00:00Z')`,
      [conversationId, workspace.id, agent.id],
    );
    await database.query(
      "INSERT INTO messages (id, conversation_id, workspace_id, role, content, created_at) VALUES ($1, $2, $3, 'user', 'private message body', '2026-07-10T10:01:00Z')",
      [messageId, conversationId, workspace.id],
    );
    await database.query(
      `INSERT INTO usage_events (
         id, idempotency_key, account_id, workspace_id, conversation_id, message_id, surface, operation,
         provider, model, input_tokens, output_tokens, reasoning_tokens, total_tokens, vector_count,
         event_kind, status, usage_quality, occurred_at
       ) VALUES
         ($1, $2, $3, $4, $5, $6, 'assistant', 'answer', 'openai', 'gpt-5', 100, 40, 12, 140, 0, 'model', 'succeeded', 'actual', '2026-07-10T10:03:00Z'),
         ($7, $8, $3, $4, $5, $6, 'assistant', 'answer', 'openai', 'gpt-5', 50, 20, NULL, 60, 0, 'model', 'succeeded', 'actual', '2026-07-10T10:03:00Z'),
         ($9, $10, $3, $4, $5, $6, 'retrieval', 'query_embedding', 'openai', 'text-embedding-3-small', 9, 0, NULL, 9, 1, 'embedding', 'succeeded', 'actual', '2026-07-10T10:02:00Z')`,
      [
        randomUUID(), `usage-details-test-model-${randomUUID()}`, account.id, workspace.id, conversationId, messageId,
        randomUUID(), `usage-details-test-model-without-reasoning-${randomUUID()}`,
        randomUUID(), `usage-details-test-embedding-${randomUUID()}`,
      ],
    );

    const response = await service.getMessageUsage({
      accountId: account.id,
      userId,
      from: "2026-07-01",
      to: "2026-07-30",
      limit: 50,
    });

    expect(response.items).toEqual([expect.objectContaining({
      messageId,
      conversationId,
      modelTokens: {
        input: 150,
        completion: 60,
        reasoning: { tokens: 12, coverage: "partial" },
        visibleOutput: null,
        total: 200,
      },
      embeddingTokens: { input: 9, total: 9, vectors: 1, attempts: 1 },
    })]);
    expect(JSON.stringify(response)).not.toContain("private message body");
  });

  it("sends operator, eval, failed zero-vector embedding, and unlinked work to internal operations", async () => {
    const { account, workspace, agent, userId, service } = await createService();
    const operatorConversationId = randomUUID();
    const operatorMessageId = randomUUID();
    const visitorConversationId = randomUUID();
    const visitorMessageId = randomUUID();
    await database.query(
      `INSERT INTO conversations (id, workspace_id, agent_id, source_channel, created_at, updated_at)
       VALUES ($1, $2, $3, 'authenticated_chat', '2026-07-11T10:00:00Z', '2026-07-11T10:00:00Z')`,
      [operatorConversationId, workspace.id, agent.id],
    );
    await database.query(
      "INSERT INTO messages (id, conversation_id, workspace_id, role, content, created_at) VALUES ($1, $2, $3, 'user', 'operator only', '2026-07-11T10:01:00Z')",
      [operatorMessageId, operatorConversationId, workspace.id],
    );
    await database.query(
      `INSERT INTO conversations (id, workspace_id, agent_id, source_channel, created_at, updated_at)
       VALUES ($1, $2, $3, 'dashboard', '2026-07-11T10:00:00Z', '2026-07-11T10:00:00Z')`,
      [visitorConversationId, workspace.id, agent.id],
    );
    await database.query(
      "INSERT INTO messages (id, conversation_id, workspace_id, role, content, created_at) VALUES ($1, $2, $3, 'user', 'visitor private body', '2026-07-11T10:01:00Z')",
      [visitorMessageId, visitorConversationId, workspace.id],
    );
    await database.query(
      `INSERT INTO usage_events (
         id, idempotency_key, account_id, workspace_id, conversation_id, message_id, surface, operation,
         provider, model, input_tokens, output_tokens, reasoning_tokens, total_tokens, vector_count,
         event_kind, status, usage_quality, occurred_at
       ) VALUES
         ($1, $2, $3, $4, $5, $6, 'assistant', 'answer', 'openai', 'gpt-5', 3, 2, NULL, 5, 0, 'model', 'succeeded', 'actual', '2026-07-11T10:02:00Z'),
         ($7, $8, $3, $4, NULL, NULL, 'documents', 'document_enrichment', 'openai', 'text-embedding-3-small', 10, 0, NULL, 10, 0, 'embedding', 'failed', 'estimated', '2026-07-11T10:03:00Z'),
         ($9, $10, $3, $4, NULL, NULL, 'legacy', 'unknown', 'openai', 'old-model', 7, 4, NULL, 11, 0, 'unknown', 'failed', 'estimated', '2026-07-11T10:04:00Z'),
         ($11, $12, $3, $4, $13, $14, 'eval', 'score_response', 'openai', 'gpt-5-mini', 4, 3, 1, 7, 0, 'model', 'succeeded', 'actual', '2026-07-11T10:05:00Z')`,
      [
        randomUUID(), `usage-details-test-operator-${randomUUID()}`, account.id, workspace.id, operatorConversationId, operatorMessageId,
        randomUUID(), `usage-details-test-embedding-failure-${randomUUID()}`,
        randomUUID(), `usage-details-test-unknown-${randomUUID()}`,
        randomUUID(), `usage-details-test-eval-${randomUUID()}`, visitorConversationId, visitorMessageId,
      ],
    );

    const response = await service.getInternalUsage({
      accountId: account.id,
      userId,
      from: "2026-07-01",
      to: "2026-07-30",
      limit: 50,
    });

    expect(response.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "model", operation: expect.objectContaining({ label: "Test chat: Answer" }) }),
      expect.objectContaining({
        kind: "embedding",
        operation: expect.objectContaining({ label: "Metadata generation" }),
        status: "failed",
        vectorCount: 0,
        tokens: expect.objectContaining({ completion: null, reasoning: null, visibleOutput: null }),
      }),
      expect.objectContaining({ kind: "unknown" }),
      expect.objectContaining({
        kind: "model",
        operation: expect.objectContaining({ surface: "eval", label: "Evaluation: Score Response" }),
      }),
    ]));

    const messageResponse = await service.getMessageUsage({
      accountId: account.id,
      userId,
      from: "2026-07-01",
      to: "2026-07-30",
      limit: 50,
    });
    expect(messageResponse.items).toHaveLength(0);
    expect(JSON.stringify(messageResponse)).not.toContain("visitor private body");
  });

  it("paginates message usage without losing microsecond timestamp precision", async () => {
    const { account, workspace, agent, userId, service } = await createService();
    const conversationId = randomUUID();
    const messageIds = [randomUUID(), randomUUID(), randomUUID()];
    const occurredAts = [
      "2026-07-12T10:03:00.123789Z",
      "2026-07-12T10:03:00.123789Z",
      "2026-07-12T10:03:00.123456Z",
    ];
    await database.query(
      `INSERT INTO conversations (id, workspace_id, agent_id, source_channel, created_at, updated_at)
       VALUES ($1, $2, $3, 'dashboard', '2026-07-12T10:00:00Z', '2026-07-12T10:00:00Z')`,
      [conversationId, workspace.id, agent.id],
    );
    for (const [index, messageId] of messageIds.entries()) {
      await database.query(
        "INSERT INTO messages (id, conversation_id, workspace_id, role, content, created_at) VALUES ($1, $2, $3, 'user', 'hidden visitor text', '2026-07-12T10:01:00Z')",
        [messageId, conversationId, workspace.id],
      );
      await database.query(
        `INSERT INTO usage_events (
           id, idempotency_key, account_id, workspace_id, conversation_id, message_id, surface, operation,
           provider, model, input_tokens, output_tokens, reasoning_tokens, total_tokens, vector_count,
           event_kind, status, usage_quality, occurred_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 'assistant', 'answer', 'openai', 'gpt-5', 10, 4, 1, 14, 0, 'model', 'succeeded', 'actual', $7)`,
        [randomUUID(), `usage-details-test-page-${randomUUID()}`, account.id, workspace.id, conversationId, messageId, occurredAts[index]],
      );
    }

    const firstPage = await service.getMessageUsage({
      accountId: account.id,
      userId,
      from: "2026-07-01",
      to: "2026-07-30",
      limit: 1,
    });
    const secondPage = await service.getMessageUsage({
      accountId: account.id,
      userId,
      from: "2026-07-01",
      to: "2026-07-30",
      limit: 1,
      cursor: firstPage.nextCursor ?? undefined,
    });
    const thirdPage = await service.getMessageUsage({
      accountId: account.id,
      userId,
      from: "2026-07-01",
      to: "2026-07-30",
      limit: 1,
      cursor: secondPage.nextCursor ?? undefined,
    });

    expect(firstPage.nextCursor).not.toBeNull();
    expect(secondPage.nextCursor).not.toBeNull();
    expect(thirdPage.nextCursor).toBeNull();
    expect(new Set([...firstPage.items, ...secondPage.items, ...thirdPage.items].map((item) => item.messageId))).toEqual(new Set(messageIds));
  });

  it("paginates internal usage without losing microsecond timestamp precision", async () => {
    const { account, workspace, userId, service } = await createService();
    const eventIds = [randomUUID(), randomUUID(), randomUUID()];
    const occurredAts = [
      "2026-07-12T11:03:00.123789Z",
      "2026-07-12T11:03:00.123789Z",
      "2026-07-12T11:03:00.123456Z",
    ];

    for (const [index, eventId] of eventIds.entries()) {
      await database.query(
        `INSERT INTO usage_events (
           id, idempotency_key, account_id, workspace_id, surface, operation,
           provider, model, input_tokens, output_tokens, reasoning_tokens, total_tokens, vector_count,
           event_kind, status, usage_quality, occurred_at
         ) VALUES ($1, $2, $3, $4, 'agent_wizard', 'analyze_website', 'openai', 'gpt-5-mini', 10, 4, 1, 14, 0, 'model', 'succeeded', 'actual', $5)`,
        [eventId, `usage-details-test-internal-page-${randomUUID()}`, account.id, workspace.id, occurredAts[index]],
      );
    }

    const firstPage = await service.getInternalUsage({
      accountId: account.id,
      userId,
      from: "2026-07-01",
      to: "2026-07-30",
      limit: 1,
    });
    const secondPage = await service.getInternalUsage({
      accountId: account.id,
      userId,
      from: "2026-07-01",
      to: "2026-07-30",
      limit: 1,
      cursor: firstPage.nextCursor ?? undefined,
    });
    const thirdPage = await service.getInternalUsage({
      accountId: account.id,
      userId,
      from: "2026-07-01",
      to: "2026-07-30",
      limit: 1,
      cursor: secondPage.nextCursor ?? undefined,
    });

    expect(firstPage.nextCursor).not.toBeNull();
    expect(secondPage.nextCursor).not.toBeNull();
    expect(thirdPage.nextCursor).toBeNull();
    expect(new Set([...firstPage.items, ...secondPage.items, ...thirdPage.items].map((item) => item.eventId))).toEqual(new Set(eventIds));
  });

  it("rejects a workspace filter owned by another account", async () => {
    const { account, userId, service } = await createService();
    const other = await accountRepository.create({
      email: `usage-details-other-${randomUUID()}@example.com`,
      name: "Other account",
      passwordHash: "hash",
    });
    accountIds.push(other.id);
    const foreignWorkspace = await workspaceRepository.create(other.id, "Foreign usage workspace");

    await expect(service.getMessageUsage({
      accountId: account.id,
      userId,
      from: "2026-07-01",
      to: "2026-07-30",
      limit: 50,
      workspaceId: foreignWorkspace.id,
    })).rejects.toMatchObject({ statusCode: 400, code: "bad_request" });
  });

  it("rejects a malformed cursor and date ranges wider than the reporting bound", async () => {
    const { account, userId, service } = await createService();

    await expect(service.getInternalUsage({
      accountId: account.id,
      userId,
      from: "2026-07-01",
      to: "2026-07-30",
      limit: 50,
      cursor: "not-a-valid-cursor",
    })).rejects.toMatchObject({ statusCode: 400, code: "bad_request" });

    await expect(service.getMessageUsage({
      accountId: account.id,
      userId,
      from: "2026-01-01",
      to: "2026-07-30",
      limit: 50,
    })).rejects.toMatchObject({ statusCode: 400, code: "bad_request" });
  });
});
