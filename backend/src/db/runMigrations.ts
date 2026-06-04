import { readdir, readFile } from "node:fs/promises";

import { Database } from "../shared/infra/database.js";
import type { AppLogger } from "../shared/observability/logger.js";

const migrationsDirectory = new URL("./migrations/", import.meta.url);
const migrationTableName = "schema_migrations";
const qualifiedMigrationTableName = `public.${migrationTableName}`;

export interface MigrationTimeoutOptions {
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
}

export const DEFAULT_MIGRATION_LOCK_TIMEOUT_MS = 10_000;
export const DEFAULT_MIGRATION_STATEMENT_TIMEOUT_MS = 25_000;

const listMigrationFiles = async (): Promise<string[]> =>
  (await readdir(migrationsDirectory))
    .filter((file) => file.endsWith(".sql"))
    .sort();

export const listPendingMigrations = async (
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

export const runMigrations = async (
  connectionString: string,
  logger: AppLogger,
  options: MigrationTimeoutOptions = {},
): Promise<void> => {
  const database = createMigrationDatabase(connectionString, options);

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
    await database.close();
  }
};
