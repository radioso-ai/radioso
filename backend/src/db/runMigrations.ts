import { readdir, readFile } from "node:fs/promises";

import { Database } from "../shared/infra/database.js";
import type { AppLogger } from "../shared/observability/logger.js";

const migrationsDirectory = new URL("./migrations/", import.meta.url);

const listMigrationFiles = async (): Promise<string[]> =>
  (await readdir(migrationsDirectory))
    .filter((file) => file.endsWith(".sql"))
    .sort();

export const listPendingMigrations = async (connectionString: string): Promise<string[]> => {
  const database = new Database(connectionString);

  try {
    const migrationFiles = await listMigrationFiles();
    const [schemaTable] = await database.query<{ migration_table: string | null }>(
      "SELECT to_regclass('public.schema_migrations') AS migration_table",
    );

    if (!schemaTable?.migration_table) {
      return migrationFiles;
    }

    const appliedMigrationsResult = await database.pool.query<{ filename: string }>(
      "SELECT filename FROM schema_migrations",
    );
    const appliedMigrations = new Set(appliedMigrationsResult.rows.map((row) => row.filename));

    return migrationFiles.filter((migrationFile) => !appliedMigrations.has(migrationFile));
  } finally {
    await database.close();
  }
};

export const ensureNoPendingMigrations = async (connectionString: string): Promise<void> => {
  const pendingMigrations = await listPendingMigrations(connectionString);

  if (pendingMigrations.length > 0) {
    throw new Error(`Pending SQL migrations detected: ${pendingMigrations.join(", ")}`);
  }
};

export const runMigrations = async (connectionString: string, logger: AppLogger): Promise<void> => {
  const database = new Database(connectionString);

  try {
    const migrationFiles = await listMigrationFiles();

    await database.pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const appliedMigrationsResult = await database.pool.query<{ filename: string }>(
      "SELECT filename FROM schema_migrations",
    );
    const appliedMigrations = new Set(appliedMigrationsResult.rows.map((row) => row.filename));

    for (const migrationFile of migrationFiles) {
      if (appliedMigrations.has(migrationFile)) {
        logger.info({ migrationFile }, "database migration already applied");
        continue;
      }

      const migrationSql = await readFile(new URL(migrationFile, migrationsDirectory), "utf8");
      await database.withTransaction(async (client) => {
        await client.query(migrationSql);
        await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [migrationFile]);
      });
      logger.info({ migrationFile }, "database migration applied");
    }
  } finally {
    await database.close();
  }
};
