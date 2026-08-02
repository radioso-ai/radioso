import { readdir, readFile } from "node:fs/promises";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ensureNoPendingMigrations,
  parseMigrationScript,
  runMigrations,
} from "../../src/db/runMigrations.js";
import type { AppLogger } from "../../src/shared/observability/logger.js";

type QueryCall = {
  sql: string;
  params?: unknown[];
};

type MockDatabaseInstance = {
  connectionString: string;
  options: unknown;
  poolQueries: QueryCall[];
  transactionQueries: QueryCall[];
  pool: {
    query: ReturnType<typeof vi.fn>;
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
}));

vi.mock("../../src/shared/infra/database.js", () => ({
  Database: vi.fn(function Database(connectionString: string, options: unknown = {}) {
    const instance: MockDatabaseInstance = {
      connectionString,
      options,
      poolQueries: [],
      transactionQueries: [],
      pool: {
        query: vi.fn(async (sql: string, params?: unknown[]) => {
          instance.poolQueries.push({ sql, params });
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
            instance.transactionQueries.push({ sql, params });
            return { rows: [], rowCount: 0 };
          }),
        };

        return callback(client);
      }),
      close: vi.fn().mockResolvedValue(undefined),
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
    const migrationFiles = await listMigrationFiles();
    const transactionalCount = (await Promise.all(migrationFiles.map(async (file) =>
      parseMigrationScript(await readFile(new URL(`../../src/db/migrations/${file}`, import.meta.url), "utf8")))))
      .filter((script) => script.transactional).length;
    expect(database?.withTransaction).toHaveBeenCalledTimes(transactionalCount);
    expect(database?.transactionQueries.some((query) => query.sql.includes("INSERT INTO public.schema_migrations"))).toBe(true);
    expect(database?.poolQueries.some((query) =>
      query.sql.includes("CREATE UNIQUE INDEX CONCURRENTLY"),
    )).toBe(true);
  });

  it("runs explicitly non-transactional migration statements in autocommit mode with bounded pool timeouts", async () => {
    const migrationFiles = await listMigrationFiles();
    const scripts = await Promise.all(migrationFiles.map(async (file) => ({
      file,
      script: parseMigrationScript(
        await readFile(new URL(`../../src/db/migrations/${file}`, import.meta.url), "utf8"),
      ),
    })));
    const nonTransactional = scripts.find(({ script }) => !script.transactional);
    expect(nonTransactional).toBeDefined();
    if (!nonTransactional) return;
    databaseState.appliedFilenames = migrationFiles.filter((file) => file !== nonTransactional.file);

    await runMigrations("postgres://user:secret@localhost:5432/radioso", createLogger());

    const database = databaseState.instances[0]!;
    expect(database.withTransaction).not.toHaveBeenCalled();
    expect(database.poolQueries.map(({ sql }) => sql)).toEqual(expect.arrayContaining([
      expect.stringContaining("DROP INDEX CONCURRENTLY IF EXISTS"),
      expect.stringContaining("CREATE UNIQUE INDEX CONCURRENTLY"),
      "INSERT INTO public.schema_migrations (filename) VALUES ($1)",
    ]));
    expect(database.poolQueries.find(({ sql }) =>
      sql === "INSERT INTO public.schema_migrations (filename) VALUES ($1)"),
    ).toMatchObject({ params: [nonTransactional.file] });
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
});

describe("parseMigrationScript", () => {
  it("keeps ordinary migration bodies transactional", () => {
    expect(parseMigrationScript("CREATE TABLE example (id UUID PRIMARY KEY);\n")).toEqual({
      transactional: true,
      statements: ["CREATE TABLE example (id UUID PRIMARY KEY);"],
    });
  });

  it("splits explicitly non-transactional migrations into restart-safe autocommit statements", () => {
    expect(parseMigrationScript(`-- radioso:migration-transaction: off
DROP INDEX CONCURRENTLY IF EXISTS idx_example;
-- radioso:migration-statement-break
CREATE UNIQUE INDEX CONCURRENTLY idx_example ON example (workspace_id, id);
`)).toEqual({
      transactional: false,
      statements: [
        "-- radioso:migration-transaction: off\nDROP INDEX CONCURRENTLY IF EXISTS idx_example;",
        "CREATE UNIQUE INDEX CONCURRENTLY idx_example ON example (workspace_id, id);",
      ],
    });
  });
});
