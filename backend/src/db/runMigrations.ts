import { readdir, readFile } from "node:fs/promises";

import type { PoolClient } from "pg";

import { Database } from "../shared/infra/database.js";
import type { AppLogger } from "../shared/observability/logger.js";

const migrationsDirectory = new URL("./migrations/", import.meta.url);
const migrationTableName = "schema_migrations";
const qualifiedMigrationTableName = `public.${migrationTableName}`;

export interface MigrationTimeoutOptions {
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
}

const DEFAULT_MIGRATION_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_MIGRATION_STATEMENT_TIMEOUT_MS = 25_000;

/**
 * Identifies the schema-migration runner's session-level advisory lock. This literal must
 * never change: a different value would let two backend versions apply migrations
 * concurrently during a rolling deploy, defeating the lock it exists to enforce. Passed as
 * a string query parameter (cast to `::bigint` in SQL) rather than a JS number, so there is
 * no risk of floating-point precision loss on a large literal.
 */
export const MIGRATION_ADVISORY_LOCK_KEY = "748201953186471";

// SQLSTATE for `lock_not_available`, the error Postgres raises when `lock_timeout` elapses
// while a session waits on `pg_advisory_lock`. Detected by code, never by message text.
const POSTGRES_LOCK_NOT_AVAILABLE_SQLSTATE = "55P03";

const listMigrationFiles = async (): Promise<string[]> =>
  (await readdir(migrationsDirectory))
    .filter((file) => file.endsWith(".sql"))
    .sort();

const listPendingMigrations = async (
  connectionString: string,
  options: MigrationTimeoutOptions = {},
): Promise<string[]> => {
  const database = createMigrationDatabase(connectionString, options);

  try {
    const migrationFiles = await listMigrationFiles();
    const [schemaTable] = await database.query<{ migration_table: string | null }>(
      "SELECT to_regclass('public.schema_migrations') AS migration_table",
    );

    if (!schemaTable?.migration_table) {
      return migrationFiles;
    }

    const appliedMigrationsResult = await database.pool.query<{ filename: string }>(
      `SELECT filename FROM ${qualifiedMigrationTableName}`,
    );
    const appliedMigrations = new Set(appliedMigrationsResult.rows.map((row) => row.filename));

    return migrationFiles.filter((migrationFile) => !appliedMigrations.has(migrationFile));
  } finally {
    await database.close();
  }
};

export const ensureNoPendingMigrations = async (
  connectionString: string,
  options: MigrationTimeoutOptions = {},
): Promise<void> => {
  const pendingMigrations = await listPendingMigrations(connectionString, options);

  if (pendingMigrations.length > 0) {
    throw new Error(`Pending SQL migrations detected: ${pendingMigrations.join(", ")}`);
  }
};

const createMigrationDatabase = (connectionString: string, options: MigrationTimeoutOptions): Database =>
  new Database(connectionString, {
    applicationName: "radioso-migrations",
    lockTimeoutMs: options.lockTimeoutMs ?? DEFAULT_MIGRATION_LOCK_TIMEOUT_MS,
    statementTimeoutMs: options.statementTimeoutMs ?? DEFAULT_MIGRATION_STATEMENT_TIMEOUT_MS,
  });

const migrationMetadataTableExists = async (database: Database): Promise<boolean> => {
  const result = await database.pool.query<{ migration_table: string | null }>(
    "SELECT to_regclass('public.schema_migrations') AS migration_table",
  );

  return Boolean(result.rows[0]?.migration_table);
};

const createMigrationMetadataTable = async (database: Database): Promise<void> => {
  await database.pool.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
};

const disableMigrationBodyTimeouts = async (
  client: { query(sql: string, params?: unknown[]): Promise<unknown> },
): Promise<void> => {
  await client.query("SET LOCAL lock_timeout = 0");
  await client.query("SET LOCAL statement_timeout = 0");
};

const isPostgresLockNotAvailableError = (error: unknown): boolean =>
  Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && (error as { code?: unknown }).code === POSTGRES_LOCK_NOT_AVAILABLE_SQLSTATE,
  );

// Blocks until the session-level lock is granted. The migration connection already carries
// `lock_timeout` (see createMigrationDatabase), and `pg_advisory_lock` honours it, so a
// waiter that outlasts another instance's whole migration run fails loudly here instead of
// hanging past the platform's startup probe.
const acquireBlockingMigrationLock = async (client: PoolClient): Promise<void> => {
  try {
    await client.query("SELECT pg_advisory_lock($1::bigint)", [MIGRATION_ADVISORY_LOCK_KEY]);
  } catch (error) {
    if (isPostgresLockNotAvailableError(error)) {
      throw new Error(
        "Timed out waiting for the database migration lock held by another instance (DB_MIGRATION_LOCK_TIMEOUT_MS)",
        { cause: error },
      );
    }

    throw error;
  }
};

interface MigrationLock {
  release: () => Promise<void>;
}

/**
 * Acquires the schema-migration session-level advisory lock on a dedicated pool client and
 * holds it until {@link MigrationLock.release} is called. Session-level, not
 * transaction-level, because each pending migration runs in its own `withTransaction` on a
 * different pool client — a transaction-scoped lock would release between migrations, not
 * across the whole run. Acquired before any metadata-table check or read, so two backend
 * instances booting concurrently never both see the same migration as pending.
 */
const acquireMigrationLock = async (database: Database, logger: AppLogger): Promise<MigrationLock> => {
  const client = await database.pool.connect();

  try {
    const tryLockResult = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1::bigint) AS locked",
      [MIGRATION_ADVISORY_LOCK_KEY],
    );

    if (!tryLockResult.rows[0]?.locked) {
      logger.info(
        { lockKey: MIGRATION_ADVISORY_LOCK_KEY },
        "database migration lock held by another instance; waiting",
      );
      await acquireBlockingMigrationLock(client);
    }
  } catch (error) {
    // Destroy rather than repool: a failed acquire may leave the connection unusable.
    client.release(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }

  return {
    // Best-effort: the lock is session-scoped, so closing the pool releases it anyway. A
    // failed unlock must not mask the migration error that is usually the reason we are here.
    release: async () => {
      try {
        await client.query("SELECT pg_advisory_unlock($1::bigint)", [MIGRATION_ADVISORY_LOCK_KEY]);
        client.release();
      } catch (error) {
        logger.warn({ err: error }, "database migration lock release failed; closing the session instead");
        client.release(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
};

export const runMigrations = async (
  connectionString: string,
  logger: AppLogger,
  options: MigrationTimeoutOptions = {},
): Promise<void> => {
  const database = createMigrationDatabase(connectionString, options);

  try {
    const lock = await acquireMigrationLock(database, logger);

    try {
      const migrationFiles = await listMigrationFiles();

      if (!(await migrationMetadataTableExists(database))) {
        await createMigrationMetadataTable(database);
      }

      const appliedMigrationsResult = await database.pool.query<{ filename: string }>(
        `SELECT filename FROM ${qualifiedMigrationTableName}`,
      );
      const appliedMigrations = new Set(appliedMigrationsResult.rows.map((row) => row.filename));

      for (const migrationFile of migrationFiles) {
        if (appliedMigrations.has(migrationFile)) {
          logger.info({ migrationFile }, "database migration already applied");
          continue;
        }

        const migrationSql = await readFile(new URL(migrationFile, migrationsDirectory), "utf8");
        await database.withTransaction(async (client) => {
          await disableMigrationBodyTimeouts(client);
          // Migration filenames are recorded only after the SQL transaction succeeds.
          // IF NOT EXISTS in migration SQL is for drift tolerance, not normal re-runs.
          await client.query(migrationSql);
          await client.query(`INSERT INTO ${qualifiedMigrationTableName} (filename) VALUES ($1)`, [migrationFile]);
        });
        logger.info({ migrationFile }, "database migration applied");
      }
    } finally {
      await lock.release();
    }
  } finally {
    await database.close();
  }
};
