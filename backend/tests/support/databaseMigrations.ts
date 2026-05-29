import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Database } from "../../src/shared/infra/database.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const testMigrationsPath = path.resolve(__dirname, "../../src/db/migrations");
const migrationAdvisoryLockKey = 72_341_901;

export const runAllTestMigrations = async (database: Database): Promise<void> => {
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
