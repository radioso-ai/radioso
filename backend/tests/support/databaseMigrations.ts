import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Database } from "../../src/shared/infra/database.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const testMigrationsPath = path.resolve(__dirname, "../../src/db/migrations");
const migrationAdvisoryLockKey = 72_341_901;
const maxMigrationAttempts = 3;

const isDeadlockError = (error: unknown): boolean =>
  Boolean(error && typeof error === "object" && "code" in error && error.code === "40P01");

export const runAllTestMigrations = async (database: Database): Promise<void> => {
  for (let attempt = 1; attempt <= maxMigrationAttempts; attempt += 1) {
    try {
      await runAllTestMigrationsOnce(database);
      return;
    } catch (error) {
      if (!isDeadlockError(error) || attempt === maxMigrationAttempts) {
        throw error;
      }
    }
  }
};

// Re-add the workspace retrieval/query-time columns that migration 081 drops, so the
// data-migration tests for 075/080 can seed the schema those migrations read. Idempotent;
// safe on a fully-migrated DB whether or not 081 has already dropped them. Defaults mirror
// the original DDL (migrations 001/003/008). For migration tests ONLY — production has these
// columns removed.
export const ensureLegacyRetrievalColumns = async (database: Database): Promise<void> => {
  await database.execute(`
    ALTER TABLE retrieval_settings
      ADD COLUMN IF NOT EXISTS query_rewrite_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS rerank_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS vector_top_k INTEGER NOT NULL DEFAULT 10,
      ADD COLUMN IF NOT EXISTS similarity_threshold DOUBLE PRECISION NOT NULL DEFAULT 0.2,
      ADD COLUMN IF NOT EXISTS rerank_top_k INTEGER NOT NULL DEFAULT 5,
      ADD COLUMN IF NOT EXISTS custom_instruction TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS attribute_controls JSONB NOT NULL DEFAULT '{}'::jsonb;
  `);
};

const runAllTestMigrationsOnce = async (database: Database): Promise<void> => {
  const client = await database.pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [migrationAdvisoryLockKey]);
    const migrationFiles = (await readdir(testMigrationsPath))
      .filter((file) => file.endsWith(".sql"))
      .sort();

    for (const migrationFile of migrationFiles) {
      const migrationSql = await readFile(path.join(testMigrationsPath, migrationFile), "utf8");
      await client.query(migrationSql);
    }
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [migrationAdvisoryLockKey]);
    } finally {
      client.release();
    }
  }
};
