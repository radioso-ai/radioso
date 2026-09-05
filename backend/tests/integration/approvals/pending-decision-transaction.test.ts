import { randomUUID } from "node:crypto";

import type { PoolClient, QueryResultRow } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PendingDecisionRepository,
  type PendingDecisionCreateInput,
} from "../../../src/db/repositories/pendingDecisionRepository.js";
import { Database } from "../../../src/shared/infra/database.js";
import { createKyselyDatabase } from "../../../src/shared/infra/kysely/kyselyDatabase.js";
import type { Db } from "../../../src/shared/infra/kysely/types.js";
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

const createClientBackedDatabase = (client: PoolClient): Database => {
  // A one-connection pool that always hands back the same open client so the Kysely
  // transaction opened by `resolveInTransaction` runs on the same per-test schema + client
  // as the verification queries; `release` is neutered so Kysely cannot reclaim it.
  const pool = {
    async connect() {
      return new Proxy(client, {
        get(target, property, receiver) {
          if (property === "release") {
            return () => undefined;
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  } as Database["pool"];

  return {
  pool,
  kysely: createKyselyDatabase(pool),
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
};
};

const decisionInput = (overrides: Partial<PendingDecisionCreateInput> = {}): PendingDecisionCreateInput => ({
  handle: `decision_${randomUUID()}`,
  conversationId: randomUUID(),
  sessionId: randomUUID(),
  workspaceId: randomUUID(),
  agentId: randomUUID(),
  routineId: "routine_escalation",
  stepId: "step_review",
  reason: "Needs operator review",
  options: [{ id: "approve", label: "Approve" }],
  deciderScope: { kind: "workspace_member" },
  contentHash: `sha256:${randomUUID()}`,
  deadline: null,
  ...overrides,
});

describeIfDatabase("PendingDecisionRepository transaction helper", () => {
  let database: Database;
  let backingDatabase: Database;
  let client: PoolClient;
  let schema: string;
  let repository: PendingDecisionRepository;

  beforeAll(async () => {
    backingDatabase = new Database(integrationDatabaseUrl!);
    client = await backingDatabase.pool.connect();
    schema = `pending_decision_txn_${randomUUID().replaceAll("-", "_")}`;
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    database = createClientBackedDatabase(client);
    await applyTestMigration(database, "104_pending_decisions.sql");
    repository = new PendingDecisionRepository(database.kysely);
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

  it("runs the pending-decision CAS and caller resume work on the same transaction", async () => {
    const input = decisionInput();
    await repository.create(input);

    const result = await repository.resolveInTransaction({
      handle: input.handle,
      status: "resolved",
      decision: { optionId: "approve" },
      decidedBy: null,
      contentHash: input.contentHash,
    }, async (record, db: Db) => {
      // The caller's work runs on the same transaction `db`: it observes the just-flipped
      // row (still uncommitted at this point) by reading it back through the same handle.
      const seen = await db
        .selectFrom("pending_decisions")
        .select(["handle", "status"])
        .where("handle", "=", record.handle)
        .executeTakeFirstOrThrow();
      expect(seen.status).toBe("resolved");
      return record.sessionId;
    });

    expect(result).toBe(input.sessionId);
    expect(await repository.loadByHandle(input.handle)).toMatchObject({ status: "resolved" });
  });

  it("skips caller resume work when the CAS does not resolve a pending row", async () => {
    const input = decisionInput();
    await repository.create(input);
    const onResolved = vi.fn(async () => "should_not_run");

    const result = await repository.resolveInTransaction({
      handle: input.handle,
      status: "resolved",
      decision: { optionId: "approve" },
      decidedBy: null,
      contentHash: "sha256:stale",
    }, onResolved);

    expect(result).toBeNull();
    expect(onResolved).not.toHaveBeenCalled();
    expect(await repository.loadByHandle(input.handle)).toMatchObject({ status: "pending" });
  });
});
