import { randomUUID } from "node:crypto";

import type { PoolClient, QueryResultRow } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PendingDecisionRepository,
  type PendingDecisionCreateInput,
} from "../../../src/db/repositories/pendingDecisionRepository.js";
import {
  ApprovalDecisionService,
  ApprovalDecisionServiceError,
  type ResumeRunner,
} from "../../../src/modules/approvals/public.js";
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

const operatorId = randomUUID();
const workspaceId = randomUUID();
const conversationId = randomUUID();

const decisionInput = (overrides: Partial<PendingDecisionCreateInput> = {}): PendingDecisionCreateInput => ({
  handle: `decision_${randomUUID()}`,
  conversationId,
  sessionId: randomUUID(),
  workspaceId,
  agentId: randomUUID(),
  routineId: "routine_escalation",
  stepId: "await_review",
  reason: "Needs operator review",
  options: [
    { id: "approve", label: "Approve", payload: { outcome: "approved" } },
    { id: "reject", label: "Reject", description: "Send back for edits" },
  ],
  // Domain decider-scope: kind workspace_member + an explicit allow-list.
  deciderScope: { kind: "workspace_member", accountIds: [operatorId] },
  contentHash: `sha256:${randomUUID()}`,
  deadline: new Date("2026-01-02T03:04:05.000Z"),
  ...overrides,
});

describeIfDatabase("ApprovalDecisionService resolve + resume integration", () => {
  let database: Database;
  let backingDatabase: Database;
  let client: PoolClient;
  let schema: string;
  let repository: PendingDecisionRepository;

  const statusOf = async (handle: string): Promise<string | null> => {
    const row = await database.queryOptional<{ status: string }>(
      `SELECT status FROM pending_decisions WHERE handle = $1`,
      [handle],
    );
    return row?.status ?? null;
  };

  beforeAll(async () => {
    backingDatabase = new Database(integrationDatabaseUrl!);
    client = await backingDatabase.pool.connect();
    schema = `decision_resume_${randomUUID().replaceAll("-", "_")}`;
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

  const okRunner = (): ResumeRunner => ({
    resume: vi.fn(async () => ({ conversationId, resumed: true })),
  });

  it("lists only this workspace's pending decisions newest first through the service", async () => {
    const workspaceId = randomUUID();
    const otherWorkspaceId = randomUUID();
    const service = new ApprovalDecisionService(repository, okRunner());
    const older = await repository.create(decisionInput({
      workspaceId,
      conversationId: randomUUID(),
      handle: "older_pending",
    }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newer = await repository.create(decisionInput({
      workspaceId,
      conversationId: randomUUID(),
      handle: "newer_pending",
    }));
    const resolved = await repository.create(decisionInput({
      workspaceId,
      conversationId: randomUUID(),
      handle: "resolved_decision",
    }));
    await repository.create(decisionInput({
      workspaceId: otherWorkspaceId,
      conversationId: randomUUID(),
      handle: "other_workspace",
    }));
    await repository.resolve({
      handle: resolved.handle,
      outcome: "approved",
      decision: { optionId: "approve" },
      decidedBy: operatorId,
      contentHash: resolved.contentHash,
    });

    await expect(service.listPending(workspaceId)).resolves.toMatchObject([
      { id: newer.id, handle: newer.handle, status: "pending" },
      { id: older.id, handle: older.handle, status: "pending" },
    ]);
  });

  it("approves once: resumes inside the resolve transaction and flips the row exactly once", async () => {
    const input = decisionInput();
    await repository.create(input);
    const runner = okRunner();
    const service = new ApprovalDecisionService(repository, runner);

    const result = await service.resolve({
      agentId: input.agentId,
      handle: input.handle,
      optionId: "approve",
      contentHash: input.contentHash,
      caller: { accountId: operatorId, workspaceId },
    });

    expect(result).toMatchObject({ status: "resolved", decision: "approved", conversationId, resumed: true });
    expect(runner.resume).toHaveBeenCalledTimes(1);
    // Resume must receive the open transaction executor (one-tx crash-safety).
    expect(vi.mocked(runner.resume).mock.calls[0][0].executor).toBeDefined();
    expect(vi.mocked(runner.resume).mock.calls[0][0].outcome).toBe("approved");
    expect(vi.mocked(runner.resume).mock.calls[0][0].optionId).toBe("approve");
    expect(await statusOf(input.handle)).toBe("approved");

    // Exactly-once: a second submit sees a non-pending row.
    await expect(service.resolve({
      agentId: input.agentId,
      handle: input.handle,
      optionId: "approve",
      contentHash: input.contentHash,
      caller: { accountId: operatorId, workspaceId },
    })).rejects.toMatchObject({ reason: "already_resolved" });
    expect(runner.resume).toHaveBeenCalledTimes(1);
  });

  it("rejects via the rejection option without changing the outcome semantics", async () => {
    const input = decisionInput();
    await repository.create(input);
    const runner = okRunner();
    const service = new ApprovalDecisionService(repository, runner);

    const result = await service.resolve({
      agentId: input.agentId,
      handle: input.handle,
      optionId: "reject",
      contentHash: input.contentHash,
      caller: { accountId: operatorId, workspaceId },
    });

    expect(result).toMatchObject({ status: "resolved", decision: "rejected" });
    expect(vi.mocked(runner.resume).mock.calls[0][0].outcome).toBe("rejected");
    expect(await statusOf(input.handle)).toBe("rejected");
  });

  it("threads the operator's exact option id (two options share one outcome)", async () => {
    // Regression: resume must NOT reconstruct the option from the outcome — with two
    // approve-mapped options the reconstruction would pick the first and branch wrong.
    const input = decisionInput({
      options: [
        { id: "approve_full", label: "Approve full refund", payload: { outcome: "approved" } },
        { id: "approve_partial", label: "Approve partial refund", payload: { outcome: "approved" } },
        { id: "reject", label: "Reject" },
      ],
    });
    await repository.create(input);
    const runner = okRunner();
    const service = new ApprovalDecisionService(repository, runner);

    const result = await service.resolve({
      agentId: input.agentId,
      handle: input.handle,
      optionId: "approve_partial",
      contentHash: input.contentHash,
      caller: { accountId: operatorId, workspaceId },
    });

    expect(result.decision).toBe("approved");
    expect(vi.mocked(runner.resume).mock.calls[0][0].optionId).toBe("approve_partial");
  });

  it("does not resolve or resume when the content hash is stale", async () => {
    const input = decisionInput();
    await repository.create(input);
    const runner = okRunner();
    const service = new ApprovalDecisionService(repository, runner);

    await expect(service.resolve({
      agentId: input.agentId,
      handle: input.handle,
      optionId: "approve",
      contentHash: "sha256:stale",
      caller: { accountId: operatorId, workspaceId },
    })).rejects.toMatchObject({ reason: "stale_proposal" });

    expect(runner.resume).not.toHaveBeenCalled();
    expect(await statusOf(input.handle)).toBe("pending");
  });

  it("rejects an unknown option without touching the row", async () => {
    const input = decisionInput();
    await repository.create(input);
    const runner = okRunner();
    const service = new ApprovalDecisionService(repository, runner);

    await expect(service.resolve({
      agentId: input.agentId,
      handle: input.handle,
      optionId: "not-an-option",
      contentHash: input.contentHash,
      caller: { accountId: operatorId, workspaceId },
    })).rejects.toMatchObject({ reason: "invalid_option" });
    expect(runner.resume).not.toHaveBeenCalled();
    expect(await statusOf(input.handle)).toBe("pending");
  });

  it("forbids a caller outside the decider scope", async () => {
    const input = decisionInput();
    await repository.create(input);
    const runner = okRunner();
    const service = new ApprovalDecisionService(repository, runner);

    await expect(service.resolve({
      agentId: input.agentId,
      handle: input.handle,
      optionId: "approve",
      contentHash: input.contentHash,
      caller: { accountId: randomUUID(), workspaceId },
    })).rejects.toMatchObject({ reason: "forbidden_decider" });
    expect(runner.resume).not.toHaveBeenCalled();
    expect(await statusOf(input.handle)).toBe("pending");
  });

  it("treats an agent mismatch as not found", async () => {
    const input = decisionInput();
    await repository.create(input);
    const service = new ApprovalDecisionService(repository, okRunner());

    await expect(service.resolve({
      agentId: randomUUID(),
      handle: input.handle,
      optionId: "approve",
      contentHash: input.contentHash,
      caller: { accountId: operatorId, workspaceId },
    })).rejects.toBeInstanceOf(ApprovalDecisionServiceError);
    expect(await statusOf(input.handle)).toBe("pending");
  });

  it("is crash-idempotent: a failing resume rolls back the flip so a retry resolves cleanly", async () => {
    const input = decisionInput();
    await repository.create(input);

    const failing: ResumeRunner = {
      resume: vi.fn(async () => {
        throw new Error("resume boom");
      }),
    };
    const failingService = new ApprovalDecisionService(repository, failing);

    await expect(failingService.resolve({
      agentId: input.agentId,
      handle: input.handle,
      optionId: "approve",
      contentHash: input.contentHash,
      caller: { accountId: operatorId, workspaceId },
    })).rejects.toThrow("resume boom");

    // The CAS flip must have rolled back with the failed resume — row stays pending.
    expect(await statusOf(input.handle)).toBe("pending");

    // A retry with a working runner resumes and flips the row (human never re-prompted twice).
    const runner = okRunner();
    const service = new ApprovalDecisionService(repository, runner);
    const result = await service.resolve({
      agentId: input.agentId,
      handle: input.handle,
      optionId: "approve",
      contentHash: input.contentHash,
      caller: { accountId: operatorId, workspaceId },
    });

    expect(result.resumed).toBe(true);
    expect(runner.resume).toHaveBeenCalledTimes(1);
    expect(await statusOf(input.handle)).toBe("approved");
  });
});
