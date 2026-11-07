import { sql } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Database } from "../../src/shared/infra/database.js";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const canReach = async (url?: string): Promise<boolean> => {
  if (!url) return false;
  const database = new Database(url);
  try {
    await database.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await database.close().catch(() => undefined);
  }
};

const describeIfDatabase = await canReach(integrationDatabaseUrl) ? describe : describe.skip;

const QUERY_TIMEOUT_MS = 200;
const STATEMENT_TIMEOUT_MS = 800;
const SLOW_STATEMENT = "SELECT pg_sleep(5)";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// `query_timeout` is a client-side timer, so it can fire while the statement still runs on the
// server. `pg` then queues the ROLLBACK behind that statement, and drops it unsent when its own
// timer fires. With one pooled connection, a connection that goes back into the pool still inside
// the transaction fails every later statement with 25P02.
describeIfDatabase("a transaction whose rollback never reaches the server", () => {
  const databases: Database[] = [];

  const openDatabase = (warn = vi.fn()) => {
    const database = new Database(integrationDatabaseUrl!, {
      applicationName: "radioso-transaction-release-test",
      poolMax: 1,
      queryTimeoutMs: QUERY_TIMEOUT_MS,
      statementTimeoutMs: STATEMENT_TIMEOUT_MS,
      logger: { warn },
    });
    databases.push(database);
    return database;
  };

  /** Runs past the server's statement timeout, so a kept connection is now in a failed transaction. */
  const nextStatementSucceeds = async (database: Database) => {
    await sleep(STATEMENT_TIMEOUT_MS);
    const first = await sql<{ one: number }>`SELECT 1 AS one`.execute(database.kysely);
    const second = await sql<{ one: number }>`SELECT 1 AS one`.execute(database.kysely);
    expect(first.rows[0]?.one).toBe(1);
    expect(second.rows[0]?.one).toBe(1);
  };

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.close().catch(() => undefined)));
  });

  it("does not poison later statements after withTransaction times out", async () => {
    const warn = vi.fn();
    const database = openDatabase(warn);

    await expect(database.withTransaction((client) => client.query(SLOW_STATEMENT))).rejects.toThrow("Query read timeout");

    await nextStatementSucceeds(database);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ applicationName: "radioso-transaction-release-test", transactionStatus: "T" }),
      "database_connection_discarded_mid_transaction",
    );
  }, 10_000);

  it("does not poison later statements after a Kysely transaction times out", async () => {
    const database = openDatabase();

    await expect(
      database.kysely.transaction().execute((transaction) => sql`SELECT pg_sleep(5)`.execute(transaction)),
    ).rejects.toThrow("Query read timeout");

    await nextStatementSucceeds(database);
  }, 10_000);

  it("reports the error that broke the transaction, not the failed rollback", async () => {
    const database = openDatabase();

    await expect(database.withTransaction(async (client) => {
      await client.query(SLOW_STATEMENT).catch(() => undefined);
      throw new Error("the failure that matters");
    })).rejects.toThrow("the failure that matters");

    await nextStatementSucceeds(database);
  }, 10_000);

  it("keeps a connection whose transaction ended cleanly", async () => {
    const warn = vi.fn();
    const database = openDatabase(warn);
    const backendPid = async () =>
      (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(database.kysely)).rows[0]?.pid;

    const before = await backendPid();
    await database.withTransaction((client) => client.query("SELECT 1"));
    await expect(database.withTransaction(async (client) => {
      await client.query("SELECT 1 / 0");
    })).rejects.toThrow("division by zero");
    const after = await backendPid();

    expect(after).toBe(before);
    expect(warn).not.toHaveBeenCalled();
  }, 10_000);
});
