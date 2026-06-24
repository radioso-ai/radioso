import { randomUUID } from "node:crypto";

import type { PoolClient, QueryResultRow } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { RoutineState } from "@radioso/conversation-contract";

import { RoutineStateRepository } from "../../../src/db/repositories/routineStateRepository.js";
import { Database } from "../../../src/shared/infra/database.js";
import { createKyselyDatabase } from "../../../src/shared/infra/kysely/kyselyDatabase.js";
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
      }) as PoolClient;
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
  } as Database;
};

const routineState = (overrides: Partial<RoutineState> = {}): RoutineState => ({
  sessionId: randomUUID(),
  routineId: "routine.operator-review",
  path: ["collect_input", "await_review"],
  variables: { topic: "invoice" },
  attempts: { collect_input: 1 },
  status: "active",
  ...overrides,
});

describeIfDatabase("RoutineStateRepository suspended state integration", () => {
  let database: Database;
  let backingDatabase: Database;
  let client: PoolClient;
  let schema: string;
  let repository: RoutineStateRepository;

  beforeAll(async () => {
    backingDatabase = new Database(integrationDatabaseUrl!);
    client = await backingDatabase.pool.connect();
    schema = `routine_state_suspend_${randomUUID().replaceAll("-", "_")}`;
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    database = createClientBackedDatabase(client);
    await applyTestMigration(database, "071_routine_states.sql");
    await applyTestMigration(database, "085_structured_routine_guards.sql");
    repository = new RoutineStateRepository(database.kysely, 60_000);
  });

  beforeEach(async () => {
    await database.execute("TRUNCATE routine_states");
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

  it("stores suspended routine states without an expiry and loads them separately from active states", async () => {
    const suspendedState = routineState({ status: "suspended" });

    await repository.save(suspendedState);

    await expect(repository.loadActive({ sessionId: suspendedState.sessionId })).resolves.toBeNull();
    await expect(repository.loadSuspended({ sessionId: suspendedState.sessionId })).resolves.toEqual(suspendedState);

    const row = await database.queryOne<{ expires_at: Date | null }>(
      `SELECT expires_at FROM routine_states WHERE session_id = $1`,
      [suspendedState.sessionId],
    );
    expect(row.expires_at).toBeNull();
  });

  it("stores active routine states with an expiry and hides them from suspended lookups", async () => {
    const activeState = routineState({ status: "active" });

    await repository.save(activeState);

    await expect(repository.loadActive({ sessionId: activeState.sessionId })).resolves.toEqual(activeState);
    await expect(repository.loadSuspended({ sessionId: activeState.sessionId })).resolves.toBeNull();

    const row = await database.queryOne<{ expires_at: Date | null }>(
      `SELECT expires_at FROM routine_states WHERE session_id = $1`,
      [activeState.sessionId],
    );
    expect(row.expires_at).toBeInstanceOf(Date);
  });

  it("keeps suspended routine states loadable because they have no abandon-clock expiry", async () => {
    const expiringRepository = new RoutineStateRepository(database.kysely, 1);
    const suspendedState = routineState({ status: "suspended" });

    await expiringRepository.save(suspendedState);

    const row = await database.queryOne<{ expires_at: Date | null }>(
      `SELECT expires_at FROM routine_states WHERE session_id = $1`,
      [suspendedState.sessionId],
    );
    expect(row.expires_at).toBeNull();
    await expect(expiringRepository.loadSuspended({ sessionId: suspendedState.sessionId })).resolves.toEqual(suspendedState);
  });
});
