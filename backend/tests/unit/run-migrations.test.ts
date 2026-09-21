import { readdir } from "node:fs/promises";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ensureNoPendingMigrations,
  MIGRATION_ADVISORY_LOCK_KEY,
  runMigrations,
} from "../../src/db/runMigrations.js";
import type { AppLogger } from "../../src/shared/observability/logger.js";

type QueryCall = {
  sql: string;
  params?: unknown[];
  order: number;
};

type MockLockClient = {
  queries: QueryCall[];
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
};

type MockDatabaseInstance = {
  connectionString: string;
  options: unknown;
  poolQueries: QueryCall[];
  transactionQueries: QueryCall[];
  transactionCompletionOrders: number[];
  lockClient: MockLockClient | undefined;
  lockReleaseOrder: number | undefined;
  closeOrder: number | undefined;
  pool: {
    query: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
  };
  query: ReturnType<typeof vi.fn>;
  withTransaction: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

const databaseState = vi.hoisted(() => ({
  instances: [] as MockDatabaseInstance[],
  metadataTableExists: true,
  appliedFilenames: [] as string[],
  queryError: undefined as Error | undefined,
  tryLockAcquired: true,
  blockingLockError: undefined as Error | undefined,
  sequence: 0,
}));

vi.mock("../../src/shared/infra/database.js", () => ({
  Database: vi.fn(function Database(connectionString: string, options: unknown = {}) {
    const instance: MockDatabaseInstance = {
      connectionString,
      options,
      poolQueries: [],
      transactionQueries: [],
      transactionCompletionOrders: [],
      lockClient: undefined,
      lockReleaseOrder: undefined,
      closeOrder: undefined,
      pool: {
        query: vi.fn(async (sql: string, params?: unknown[]) => {
          const order = ++databaseState.sequence;
          instance.poolQueries.push({ sql, params, order });
          if (databaseState.queryError) {
            throw databaseState.queryError;
          }

          if (sql.includes("to_regclass")) {
            return {
              rows: [{ migration_table: databaseState.metadataTableExists ? "schema_migrations" : null }],
              rowCount: 1,
            };
          }

          if (sql.includes("SELECT filename FROM public.schema_migrations")) {
            return {
              rows: databaseState.appliedFilenames.map((filename) => ({ filename })),
              rowCount: databaseState.appliedFilenames.length,
            };
          }

          return { rows: [], rowCount: 0 };
        }),
        connect: vi.fn(async () => {
          const lockClient: MockLockClient = {
            queries: [],
            query: vi.fn(async (sql: string, params?: unknown[]) => {
              const order = ++databaseState.sequence;
              lockClient.queries.push({ sql, params, order });

              if (sql.includes("pg_try_advisory_lock")) {
                return { rows: [{ locked: databaseState.tryLockAcquired }], rowCount: 1 };
              }

              if (sql.includes("pg_advisory_unlock")) {
                return { rows: [{ released: true }], rowCount: 1 };
              }

              if (sql.includes("pg_advisory_lock")) {
                if (databaseState.blockingLockError) {
                  throw databaseState.blockingLockError;
                }
                return { rows: [], rowCount: 0 };
              }

              return { rows: [], rowCount: 0 };
            }),
            release: vi.fn(() => {
              instance.lockReleaseOrder = ++databaseState.sequence;
            }),
          };
          instance.lockClient = lockClient;
          return lockClient;
        }),
      },
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        const query = instance.pool.query as unknown as (
          sql: string,
          params?: unknown[],
        ) => Promise<{ rows: unknown[] }>;
        const result = await query(sql, params);
        return result.rows;
      }),
      withTransaction: vi.fn(async (callback: (client: { query(sql: string, params?: unknown[]): Promise<unknown> }) => Promise<unknown>) => {
        const client = {
          query: vi.fn(async (sql: string, params?: unknown[]) => {
            const order = ++databaseState.sequence;
            instance.transactionQueries.push({ sql, params, order });
            return { rows: [], rowCount: 0 };
          }),
        };

        const result = await callback(client);
        instance.transactionCompletionOrders.push(++databaseState.sequence);
        return result;
      }),
      close: vi.fn(async () => {
        instance.closeOrder = ++databaseState.sequence;
      }),
    };

    databaseState.instances.push(instance);
    return instance;
  }),
}));

const createLogger = (): AppLogger =>
  ({
    info: vi.fn(),
    error: vi.fn(),
  }) as unknown as AppLogger;

const listMigrationFiles = async (): Promise<string[]> =>
  (await readdir(new URL("../../src/db/migrations/", import.meta.url)))
    .filter((file) => file.endsWith(".sql"))
    .sort();

describe("runMigrations", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    databaseState.instances.length = 0;
    databaseState.metadataTableExists = true;
    databaseState.appliedFilenames = await listMigrationFiles();
    databaseState.queryError = undefined;
    databaseState.tryLockAcquired = true;
    databaseState.blockingLockError = undefined;
    databaseState.sequence = 0;
  });

  it("checks migration metadata with SELECT first and avoids metadata-table DDL when the table already exists", async () => {
    await runMigrations("postgres://user:secret@localhost:5432/radioso", createLogger());

    const [database] = databaseState.instances;
    expect(database?.connectionString).toBe("postgres://user:secret@localhost:5432/radioso");
    expect(database?.options).toMatchObject({
      applicationName: "radioso-migrations",
      lockTimeoutMs: 10_000,
      statementTimeoutMs: 25_000,
    });

    const poolSql = database?.poolQueries.map((query) => query.sql).join("\n") ?? "";
    expect(database?.poolQueries[0]?.sql).toContain("to_regclass('public.schema_migrations')");
    expect(poolSql).not.toMatch(/CREATE TABLE IF NOT EXISTS\s+(public\.)?schema_migrations/i);
    expect(database?.withTransaction).not.toHaveBeenCalled();
    expect(database?.close).toHaveBeenCalledOnce();
  });

  it("still creates the migration metadata table and applies migrations for a fresh database", async () => {
    databaseState.metadataTableExists = false;
    databaseState.appliedFilenames = [];

    await runMigrations("postgres://user:secret@localhost:5432/radioso", createLogger());

    const [database] = databaseState.instances;
    const poolSql = database?.poolQueries.map((query) => query.sql).join("\n") ?? "";
    expect(database?.poolQueries[0]?.sql).toContain("to_regclass('public.schema_migrations')");
    expect(poolSql).toMatch(/CREATE TABLE IF NOT EXISTS\s+public\.schema_migrations/i);
    expect(database?.withTransaction).toHaveBeenCalledTimes((await listMigrationFiles()).length);
    expect(database?.transactionQueries.some((query) => query.sql.includes("INSERT INTO public.schema_migrations"))).toBe(true);
  });

  it("disables metadata timeouts locally before executing pending migration SQL", async () => {
    const [firstMigration, ...remainingMigrations] = await listMigrationFiles();
    databaseState.metadataTableExists = true;
    databaseState.appliedFilenames = remainingMigrations;

    await runMigrations("postgres://user:secret@localhost:5432/radioso", createLogger());

    const transactionQueries = databaseState.instances[0]?.transactionQueries ?? [];
    expect(transactionQueries.slice(0, 2).map((query) => query.sql)).toEqual([
      "SET LOCAL lock_timeout = 0",
      "SET LOCAL statement_timeout = 0",
    ]);
    expect(transactionQueries[2]?.sql).not.toContain("SET LOCAL");
    expect(transactionQueries[3]?.sql).toBe("INSERT INTO public.schema_migrations (filename) VALUES ($1)");
    expect(transactionQueries[3]?.params).toEqual([firstMigration]);
  });

  it("allows startup callers to override migration timeout budgets", async () => {
    await runMigrations("postgres://user:secret@localhost:5432/radioso", createLogger(), {
      lockTimeoutMs: 2_500,
      statementTimeoutMs: 7_500,
    });

    expect(databaseState.instances[0]?.options).toMatchObject({
      applicationName: "radioso-migrations",
      lockTimeoutMs: 2_500,
      statementTimeoutMs: 7_500,
    });
  });

  it("propagates migration metadata lock timeout errors and closes the migration connection", async () => {
    databaseState.queryError = new Error("canceling statement due to lock timeout");

    await expect(runMigrations("postgres://user:secret@localhost:5432/radioso", createLogger()))
      .rejects
      .toThrow("canceling statement due to lock timeout");

    expect(databaseState.instances[0]?.options).toMatchObject({
      lockTimeoutMs: 10_000,
      statementTimeoutMs: 25_000,
    });
    expect(databaseState.instances[0]?.close).toHaveBeenCalledOnce();
  });

  it("uses bounded metadata checks for worker pending-migration verification", async () => {
    databaseState.metadataTableExists = true;
    databaseState.appliedFilenames = await listMigrationFiles();

    await expect(ensureNoPendingMigrations("postgres://user:secret@localhost:5432/radioso", {
      lockTimeoutMs: 3_000,
      statementTimeoutMs: 9_000,
    })).resolves.toBeUndefined();

    expect(databaseState.instances[0]?.options).toMatchObject({
      applicationName: "radioso-migrations",
      lockTimeoutMs: 3_000,
      statementTimeoutMs: 9_000,
    });
    expect(databaseState.instances[0]?.poolQueries.some((query) =>
      query.sql.includes("SELECT filename FROM public.schema_migrations"),
    )).toBe(true);
  });

  describe("session-level advisory lock", () => {
    it("tries the advisory lock on a dedicated client before checking migration metadata", async () => {
      await runMigrations("postgres://user:secret@localhost:5432/radioso", createLogger());

      const [database] = databaseState.instances;
      const firstLockQuery = database?.lockClient?.queries[0];
      expect(firstLockQuery?.sql).toContain("pg_try_advisory_lock");
      expect(firstLockQuery?.params).toEqual([MIGRATION_ADVISORY_LOCK_KEY]);

      const firstPoolQueryOrder = database?.poolQueries[0]?.order ?? Number.POSITIVE_INFINITY;
      expect(firstLockQuery?.order).toBeLessThan(firstPoolQueryOrder);
    });

    it("acquires the lock before creating the metadata table on a fresh database", async () => {
      databaseState.metadataTableExists = false;
      databaseState.appliedFilenames = [];

      await runMigrations("postgres://user:secret@localhost:5432/radioso", createLogger());

      const [database] = databaseState.instances;
      const createTableQuery = database?.poolQueries.find((query) => /CREATE TABLE IF NOT EXISTS/i.test(query.sql));
      const firstLockQuery = database?.lockClient?.queries[0];
      expect(firstLockQuery?.order).toBeLessThan(createTableQuery?.order ?? Number.POSITIVE_INFINITY);
    });

    it("re-reads the applied set only after the lock is held, with no pre-lock snapshot", async () => {
      await runMigrations("postgres://user:secret@localhost:5432/radioso", createLogger());

      const [database] = databaseState.instances;
      const appliedReads = database?.poolQueries.filter((query) =>
        query.sql.includes("SELECT filename FROM public.schema_migrations"),
      ) ?? [];
      expect(appliedReads).toHaveLength(1);
      const firstLockQuery = database?.lockClient?.queries[0];
      expect(firstLockQuery?.order).toBeLessThan(appliedReads[0]?.order ?? Number.POSITIVE_INFINITY);
    });

    it("does not log a waiting message when the try-lock succeeds immediately", async () => {
      const logger = createLogger();

      await runMigrations("postgres://user:secret@localhost:5432/radioso", logger);

      expect(logger.info).not.toHaveBeenCalledWith(
        expect.anything(),
        "database migration lock held by another instance; waiting",
      );
      const [database] = databaseState.instances;
      const lockSqls = database?.lockClient?.queries.map((query) => query.sql) ?? [];
      expect(lockSqls).toEqual([
        expect.stringContaining("pg_try_advisory_lock"),
        expect.stringContaining("pg_advisory_unlock"),
      ]);
    });

    it("logs once and falls back to the blocking lock when the try-lock is already held", async () => {
      databaseState.tryLockAcquired = false;
      const logger = createLogger();

      await runMigrations("postgres://user:secret@localhost:5432/radioso", logger);

      const [database] = databaseState.instances;
      const lockSqls = database?.lockClient?.queries.map((query) => query.sql) ?? [];
      expect(lockSqls[0]).toContain("pg_try_advisory_lock");
      expect(lockSqls[1]).toContain("pg_advisory_lock");
      expect(lockSqls[1]).not.toContain("pg_try_advisory_lock");
      expect(logger.info).toHaveBeenCalledWith(
        { lockKey: MIGRATION_ADVISORY_LOCK_KEY },
        "database migration lock held by another instance; waiting",
      );
      expect(logger.info).toHaveBeenCalledTimes(
        1 + (await listMigrationFiles()).length,
      );
    });

    it("releases the advisory lock and the dedicated client after the last migration and before closing the connection", async () => {
      databaseState.metadataTableExists = false;
      databaseState.appliedFilenames = [];

      await runMigrations("postgres://user:secret@localhost:5432/radioso", createLogger());

      const [database] = databaseState.instances;
      const lastTransactionOrder = database?.transactionCompletionOrders.at(-1) ?? -1;
      const unlockQuery = database?.lockClient?.queries.find((query) => query.sql.includes("pg_advisory_unlock"));
      expect(unlockQuery).toBeDefined();
      expect(unlockQuery?.order ?? -1).toBeGreaterThan(lastTransactionOrder);
      expect(database?.lockReleaseOrder ?? -1).toBeGreaterThan(unlockQuery?.order ?? Number.POSITIVE_INFINITY);
      expect(database?.closeOrder ?? -1).toBeGreaterThan(database?.lockReleaseOrder ?? Number.POSITIVE_INFINITY);
      expect(database?.lockClient?.release).toHaveBeenCalledOnce();
    });

    it("rejects with a named timeout error when the blocking lock wait hits SQLSTATE 55P03, and still releases the lock client", async () => {
      databaseState.tryLockAcquired = false;
      const lockTimeoutError = Object.assign(new Error("canceling statement due to lock timeout"), {
        code: "55P03",
      });
      databaseState.blockingLockError = lockTimeoutError;

      await expect(runMigrations("postgres://user:secret@localhost:5432/radioso", createLogger()))
        .rejects
        .toMatchObject({
          message: "Timed out waiting for the database migration lock held by another instance (DB_MIGRATION_LOCK_TIMEOUT_MS)",
          cause: lockTimeoutError,
        });

      const [database] = databaseState.instances;
      expect(database?.lockClient?.release).toHaveBeenCalledOnce();
      expect(database?.close).toHaveBeenCalledOnce();
      // The lock was never held (try-lock and blocking lock both failed to grant), so
      // release() must not have issued pg_advisory_unlock.
      expect(database?.lockClient?.queries.some((query) => query.sql.includes("pg_advisory_unlock"))).toBe(false);
    });

    it("propagates a non-timeout error from the blocking lock without rewriting its message, and still releases the client", async () => {
      databaseState.tryLockAcquired = false;
      const unexpectedError = new Error("connection terminated unexpectedly");
      databaseState.blockingLockError = unexpectedError;

      await expect(runMigrations("postgres://user:secret@localhost:5432/radioso", createLogger()))
        .rejects
        .toThrow("connection terminated unexpectedly");

      const [database] = databaseState.instances;
      expect(database?.lockClient?.release).toHaveBeenCalledOnce();
    });
  });
});
