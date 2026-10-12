import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { getEnv } from "../../src/app/config/env.js";
import { Database } from "../../src/shared/infra/database.js";
import { createLogger } from "../../src/shared/observability/logger.js";

const captureLines = (): { stream: Writable; lines: string[] } => {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });

  return { stream, lines };
};

const stubPoolQuery = (database: Database, rows: unknown[], rowCount: number): void => {
  database.pool.query = async () => ({
    rows,
    rowCount,
    command: "SELECT",
    oid: 0,
    fields: [],
  });
};

describe("database configuration", () => {
  it("parses explicit database pool and timeout controls", () => {
    const env = getEnv({
      NODE_ENV: "test",
      PORT: "8080",
      DATABASE_URL: "postgres://test:test@localhost:5432/test",
      DB_POOL_MAX: "7",
      DB_POOL_IDLE_TIMEOUT_MS: "12000",
      DB_POOL_CONNECTION_TIMEOUT_MS: "2500",
      DB_STATEMENT_TIMEOUT_MS: "9000",
      DB_QUERY_TIMEOUT_MS: "11000",
      DB_MIGRATION_LOCK_TIMEOUT_MS: "4000",
      DB_MIGRATION_STATEMENT_TIMEOUT_MS: "12000",
      SESSION_COOKIE_SECRET: "0123456789abcdef0123456789abcdef",
    });

    expect(env.DB_POOL_MAX).toBe(7);
    expect(env.DB_POOL_IDLE_TIMEOUT_MS).toBe(12_000);
    expect(env.DB_POOL_CONNECTION_TIMEOUT_MS).toBe(2_500);
    expect(env.DB_STATEMENT_TIMEOUT_MS).toBe(9_000);
    expect(env.DB_QUERY_TIMEOUT_MS).toBe(11_000);
    expect(env.DB_MIGRATION_LOCK_TIMEOUT_MS).toBe(4_000);
    expect(env.DB_MIGRATION_STATEMENT_TIMEOUT_MS).toBe(12_000);
  });

  it("applies safe default database pool and timeout controls", () => {
    const env = getEnv({
      NODE_ENV: "test",
      PORT: "8080",
      DATABASE_URL: "postgres://test:test@localhost:5432/test",
      SESSION_COOKIE_SECRET: "0123456789abcdef0123456789abcdef",
    });

    expect(env.DB_POOL_MAX).toBe(10);
    expect(env.DB_POOL_IDLE_TIMEOUT_MS).toBe(30_000);
    expect(env.DB_POOL_CONNECTION_TIMEOUT_MS).toBe(5_000);
    expect(env.DB_STATEMENT_TIMEOUT_MS).toBe(15_000);
    expect(env.DB_QUERY_TIMEOUT_MS).toBe(20_000);
    expect(env.DB_MIGRATION_LOCK_TIMEOUT_MS).toBe(10_000);
    expect(env.DB_MIGRATION_STATEMENT_TIMEOUT_MS).toBe(25_000);
    expect(env.WORKSPACE_TOKEN_SECRET).toBeUndefined();
    expect(env.PUBLIC_CHAT_SESSION_SECRET).toBeUndefined();
  });

  it("passes database controls through to the pg pool", () => {
    const database = new Database("postgres://test:test@localhost:5432/test", {
      poolMax: 9,
      idleTimeoutMs: 14_000,
      connectionTimeoutMs: 3_500,
      statementTimeoutMs: 8_000,
      queryTimeoutMs: 10_000,
      lockTimeoutMs: 6_000,
      applicationName: "radioso-test",
    });

    expect(database.pool.options.max).toBe(9);
    expect(database.pool.options.idleTimeoutMillis).toBe(14_000);
    expect(database.pool.options.connectionTimeoutMillis).toBe(3_500);
    expect(database.pool.options.statement_timeout).toBe(8_000);
    expect(database.pool.options.query_timeout).toBe(10_000);
    expect(database.pool.options.lock_timeout).toBe(6_000);
    expect(database.pool.options.application_name).toBe("radioso-test");

    return database.close();
  });

  it("reports a connection lost while idle in the pool instead of crashing the process", async () => {
    const warn = vi.fn();
    const database = new Database("postgres://radioso:s3cret-password@localhost:5432/test", {
      applicationName: "radioso-test",
      logger: { warn },
    });
    // pg-pool re-emits the client's error on the pool and attaches the client, which
    // carries the connection parameters.
    const lostClient = {
      connectionParameters: {
        password: "s3cret-password",
        connectionString: "postgres://radioso:s3cret-password@localhost:5432/test",
      },
    };
    const lost = Object.assign(new Error("terminating connection due to administrator command"), {
      code: "57P01",
      severity: "FATAL",
      client: lostClient,
    });

    expect(() => database.pool.emit("error", lost, lostClient)).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      {
        applicationName: "radioso-test",
        code: "57P01",
        postgresSeverity: "FATAL",
        err: "terminating connection due to administrator command",
      },
      "database_idle_connection_lost",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("s3cret-password");
    await database.close();
  });

  it("absorbs a lost idle connection when no logger is wired", async () => {
    const database = new Database("postgres://test:test@localhost:5432/test");

    expect(() => database.pool.emit("error", new Error("Connection terminated unexpectedly"))).not.toThrow();
    await database.close();
  });

  it("does not let Postgres's own severity collide with the logger's Cloud Logging severity", async () => {
    const { stream, lines } = captureLines();
    const logger = createLogger("debug", stream);
    const database = new Database("postgres://radioso:s3cret-password@localhost:5432/test", {
      applicationName: "radioso-test",
      logger,
    });

    const lost = Object.assign(new Error("terminating connection due to administrator command"), {
      code: "57P01",
      severity: "FATAL",
    });

    database.pool.emit("error", lost, { connectionParameters: { password: "s3cret-password" } });

    const [record] = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    // Pino's own Cloud Logging severity for a `warn` call must win: a JSON consumer reading
    // `severity` must see "WARNING", not Postgres's "FATAL" for a disconnect we handled.
    expect(record).toMatchObject({ severity: "WARNING", postgresSeverity: "FATAL" });

    await database.close();
  });

  it("reports a connection lost while checked out instead of crashing the process", async () => {
    const warn = vi.fn();
    const database = new Database("postgres://radioso:s3cret-password@localhost:5432/test", {
      applicationName: "radioso-test",
      logger: { warn },
    });

    const client = Object.assign(new EventEmitter(), {
      connectionParameters: {
        password: "s3cret-password",
        connectionString: "postgres://radioso:s3cret-password@localhost:5432/test",
      },
    });

    database.pool.emit("acquire", client);

    const lost = Object.assign(new Error("terminating connection due to administrator command"), {
      code: "57P01",
      severity: "FATAL",
    });

    expect(() => client.emit("error", lost)).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      {
        applicationName: "radioso-test",
        code: "57P01",
        postgresSeverity: "FATAL",
        err: "terminating connection due to administrator command",
      },
      "database_checked_out_connection_lost",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("s3cret-password");
    await database.close();
  });

  it("absorbs a connection lost while checked out when no logger is wired", async () => {
    const database = new Database("postgres://test:test@localhost:5432/test");
    const client = new EventEmitter();

    database.pool.emit("acquire", client);

    expect(() => client.emit("error", new Error("Connection terminated unexpectedly"))).not.toThrow();
    await database.close();
  });

  it("stops watching a checked-out client's errors on release, so repeated checkouts do not accumulate listeners", async () => {
    const warn = vi.fn();
    const database = new Database("postgres://test:test@localhost:5432/test", { logger: { warn } });
    const client = new EventEmitter();

    for (let i = 0; i < 5; i += 1) {
      database.pool.emit("acquire", client);
      expect(client.listenerCount("error")).toBe(1);
      database.pool.emit("release", undefined, client);
      expect(client.listenerCount("error")).toBe(0);
    }

    await database.close();
  });

  it("returns null for optional single-row queries with no rows", async () => {
    const database = new Database("postgres://test:test@localhost:5432/test");
    stubPoolQuery(database, [], 0);

    await expect(database.queryOptional<{ id: string }>("SELECT id FROM users WHERE id = $1", ["missing"])).resolves.toBeNull();
    await database.close();
  });

  it("throws when required single-row queries return no rows", async () => {
    const database = new Database("postgres://test:test@localhost:5432/test");
    stubPoolQuery(database, [], 0);

    await expect(database.queryOne<{ id: string }>("SELECT id FROM users WHERE id = $1", ["missing"])).rejects.toThrow(
      "Expected query to return one row",
    );
    await database.close();
  });

  it("returns affected row count for execute", async () => {
    const database = new Database("postgres://test:test@localhost:5432/test");
    stubPoolQuery(database, [], 3);

    await expect(database.execute("DELETE FROM sessions WHERE user_id = $1", ["user-1"])).resolves.toBe(3);
    await database.close();
  });
});
