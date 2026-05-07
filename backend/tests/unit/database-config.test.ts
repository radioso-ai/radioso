import { describe, expect, it } from "vitest";

import { getEnv } from "../../src/app/config/env.js";
import { Database } from "../../src/shared/infra/database.js";

const stubPoolQuery = (database: Database, rows: unknown[], rowCount: number): void => {
  database.pool.query = (async () => ({
    rows,
    rowCount,
    command: "SELECT",
    oid: 0,
    fields: [],
  })) as unknown as typeof database.pool.query;
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
      SESSION_COOKIE_SECRET: "0123456789abcdef0123456789abcdef",
    });

    expect(env.DB_POOL_MAX).toBe(7);
    expect(env.DB_POOL_IDLE_TIMEOUT_MS).toBe(12_000);
    expect(env.DB_POOL_CONNECTION_TIMEOUT_MS).toBe(2_500);
    expect(env.DB_STATEMENT_TIMEOUT_MS).toBe(9_000);
    expect(env.DB_QUERY_TIMEOUT_MS).toBe(11_000);
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
      applicationName: "radioso-test",
    });

    expect(database.pool.options.max).toBe(9);
    expect(database.pool.options.idleTimeoutMillis).toBe(14_000);
    expect(database.pool.options.connectionTimeoutMillis).toBe(3_500);
    expect(database.pool.options.statement_timeout).toBe(8_000);
    expect(database.pool.options.query_timeout).toBe(10_000);
    expect(database.pool.options.application_name).toBe("radioso-test");

    return database.close();
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
