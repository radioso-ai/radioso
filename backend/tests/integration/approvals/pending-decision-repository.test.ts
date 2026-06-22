import { randomUUID } from "node:crypto";

import type { PoolClient, QueryResultRow } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  PendingDecisionRepository,
  type PendingDecisionCreateInput,
} from "../../../src/db/repositories/pendingDecisionRepository.js";
import { Database } from "../../../src/shared/infra/database.js";
import { applyTestMigration } from "../../support/databaseMigrations.js";

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

const createClientBackedDatabase = (client: PoolClient): Database => ({
  pool: {} as Database["pool"],
  async query<T extends QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
    const result = await client.query<T>(text, params);
    return result.rows;
  },
  async queryOptional<T extends QueryResultRow>(text: string, params: unknown[] = []): Promise<T | null> {
    const result = await client.query<T>(text, params);
    return result.rows[0] ?? null;
  },
  async queryOne<T extends QueryResultRow>(text: string, params: unknown[] = []): Promise<T> {
    const result = await client.query<T>(text, params);
    const row = result.rows[0];
    if (!row) {
      throw new Error("Expected query to return one row");
    }
    return row;
  },
  async execute(text: string, params: unknown[] = []): Promise<number> {
    const result = await client.query(text, params);
    return result.rowCount ?? 0;
  },
  async withTransaction<T>(callback: (transactionClient: PoolClient) => Promise<T>): Promise<T> {
    await client.query("BEGIN");
    try {
      const value = await callback(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  },
  async close(): Promise<void> {},
} as Database);

const decisionInput = (overrides: Partial<PendingDecisionCreateInput> = {}): PendingDecisionCreateInput => ({
  handle: `decision_${randomUUID()}`,
  conversationId: randomUUID(),
  sessionId: randomUUID(),
  workspaceId: randomUUID(),
  agentId: randomUUID(),
  routineId: "routine_escalation",
  stepId: "step_review",
  reason: "Needs operator review",
  options: [
    { id: "approve", label: "Approve" },
    { id: "reject", label: "Reject", description: "Send back for edits" },
  ],
  deciderScope: { kind: "workspace_role", role: "owner" },
  contentHash: `sha256:${randomUUID()}`,
  deadline: new Date("2026-01-02T03:04:05.000Z"),
  ...overrides,
});

describeIfDatabase("PendingDecisionRepository Postgres integration", () => {
  let database: Database;
  let backingDatabase: Database;
  let client: PoolClient;
  let schema: string;
  let repository: PendingDecisionRepository;

  beforeAll(async () => {
    backingDatabase = new Database(integrationDatabaseUrl!);
    client = await backingDatabase.pool.connect();
    schema = `pending_decision_repo_${randomUUID().replaceAll("-", "_")}`;
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    database = createClientBackedDatabase(client);
    await applyTestMigration(database, "104_pending_decisions.sql");
    repository = new PendingDecisionRepository(database);
  });

  beforeEach(async () => {
    await database.execute("TRUNCATE pending_decisions");
  });

  afterAll(async () => {
    if (client) {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
      client.release();
    }
    if (backingDatabase) {
      await backingDatabase.close();
    }
  });

  it("creates and loads a pending decision by handle", async () => {
    const input = decisionInput();

    const created = await repository.create(input);
    const loaded = await repository.loadByHandle(input.handle);

    expect(loaded).toEqual(created);
    expect(loaded).toMatchObject({
      handle: input.handle,
      conversationId: input.conversationId,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      routineId: input.routineId,
      stepId: input.stepId,
      reason: input.reason,
      options: input.options,
      deciderScope: input.deciderScope,
      contentHash: input.contentHash,
      status: "pending",
      decision: null,
      decidedBy: null,
      decidedAt: null,
    });
    expect(loaded?.id).toEqual(expect.any(String));
    expect(loaded?.createdAt).toBeInstanceOf(Date);
    expect(loaded?.updatedAt).toBeInstanceOf(Date);
    expect(loaded?.deadline?.toISOString()).toBe(input.deadline?.toISOString());
  });

  it("resolves a decision once when the content hash matches", async () => {
    const input = decisionInput();
    await repository.create(input);

    const decidedBy = randomUUID();
    const resolved = await repository.resolve({
      handle: input.handle,
      status: "resolved",
      decision: { optionId: "approve", payload: { note: "Looks correct" } },
      decidedBy,
      contentHash: input.contentHash,
    });

    expect(resolved).toMatchObject({
      handle: input.handle,
      status: "resolved",
      decision: { optionId: "approve", payload: { note: "Looks correct" } },
      decidedBy,
    });
    expect(resolved?.decidedAt).toBeInstanceOf(Date);

    await expect(repository.resolve({
      handle: input.handle,
      status: "resolved",
      decision: { optionId: "reject" },
      decidedBy,
      contentHash: input.contentHash,
    })).resolves.toBeNull();
  });

  it("does not resolve a pending decision when the content hash is stale", async () => {
    const input = decisionInput();
    await repository.create(input);

    await expect(repository.resolve({
      handle: input.handle,
      status: "resolved",
      decision: { optionId: "approve" },
      decidedBy: randomUUID(),
      contentHash: "sha256:stale",
    })).resolves.toBeNull();

    const loaded = await repository.loadByHandle(input.handle);
    expect(loaded).toMatchObject({
      status: "pending",
      decision: null,
      decidedBy: null,
      decidedAt: null,
    });
  });

  it("rejects a second pending decision for the same conversation routine step gate", async () => {
    const conversationId = randomUUID();
    const first = decisionInput({ conversationId, routineId: "routine_review", stepId: "await_approval" });
    await repository.create(first);

    await expect(repository.create(decisionInput({
      conversationId,
      routineId: first.routineId,
      stepId: first.stepId,
      workspaceId: first.workspaceId,
      agentId: first.agentId,
      sessionId: first.sessionId,
    }))).rejects.toMatchObject({ code: "23505" });
  });

  it("lists only pending decisions for the requested workspace newest first", async () => {
    const workspaceId = randomUUID();
    const otherWorkspaceId = randomUUID();
    const older = await repository.create(decisionInput({ workspaceId, handle: "older_pending" }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newer = await repository.create(decisionInput({ workspaceId, handle: "newer_pending" }));
    const approved = await repository.create(decisionInput({ workspaceId, handle: "approved_decision" }));
    await repository.create(decisionInput({ workspaceId: otherWorkspaceId, handle: "other_workspace" }));
    await repository.resolve({
      handle: approved.handle,
      status: "resolved",
      decision: { optionId: "approve" },
      decidedBy: null,
      contentHash: approved.contentHash,
    });

    await expect(repository.listPending({ workspaceId })).resolves.toMatchObject([
      { id: newer.id, handle: newer.handle, status: "pending" },
      { id: older.id, handle: older.handle, status: "pending" },
    ]);
  });
});
