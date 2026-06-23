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

// Apply migrations in order, stopping before `stopBeforeFile` (exclusive). Lets a test pin
// a database to an earlier schema version so it can exercise a single migration's behavior
// against the data shape that existed when that migration shipped — the only way to catch
// ordering bugs (e.g. a backfill UPDATE that runs before its constraint is widened).
export const runTestMigrationsBefore = async (
  database: Database,
  stopBeforeFile: string,
): Promise<void> => {
  const migrationFiles = (await readdir(testMigrationsPath))
    .filter((file) => file.endsWith(".sql"))
    .sort();

  for (const migrationFile of migrationFiles) {
    if (migrationFile >= stopBeforeFile) {
      break;
    }
    const migrationSql = await readFile(path.join(testMigrationsPath, migrationFile), "utf8");
    await database.execute(migrationSql);
  }
};

export const applyTestMigration = async (database: Database, file: string): Promise<void> => {
  const migrationSql = await readFile(path.join(testMigrationsPath, file), "utf8");
  await database.execute(migrationSql);
};

const runAllTestMigrationsOnce = async (database: Database): Promise<void> => {
  const client = await database.pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [migrationAdvisoryLockKey]);
    // Apply each migration at most once per database, like the production runner. Integration
    // test files share one database, so re-running the whole set per file (the old behavior)
    // re-applied earlier constraint-narrowing migrations against rows that later migrations had
    // since created — e.g. migration 110/111 add agent_skills rows of kind retrieve/notify, which
    // a re-applied (pre-widening) kind CHECK then rejects. Tracking applied files makes the rerun
    // a no-op. Projection tests that exercise a single migration apply it directly via the pool,
    // independent of this helper, so they are unaffected.
    await client.query(
      "CREATE TABLE IF NOT EXISTS _test_applied_migrations (file text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const migrationFiles = (await readdir(testMigrationsPath))
      .filter((file) => file.endsWith(".sql"))
      .sort();

    for (const migrationFile of migrationFiles) {
      const alreadyApplied = await client.query(
        "SELECT 1 FROM _test_applied_migrations WHERE file = $1",
        [migrationFile],
      );
      if ((alreadyApplied.rowCount ?? 0) > 0) {
        continue;
      }
      const migrationSql = await readFile(path.join(testMigrationsPath, migrationFile), "utf8");
      await client.query(migrationSql);
      await client.query("INSERT INTO _test_applied_migrations (file) VALUES ($1)", [migrationFile]);
    }
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [migrationAdvisoryLockKey]);
    } finally {
      client.release();
    }
  }
};
