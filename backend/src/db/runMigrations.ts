import { readdir, readFile } from "node:fs/promises";

import { Database } from "../shared/infra/database.js";
import type { AppLogger } from "../shared/observability/logger.js";

const migrationsDirectory = new URL("./migrations/", import.meta.url);

export const runMigrations = async (connectionString: string, logger: AppLogger): Promise<void> => {
  const database = new Database(connectionString);

  try {
    const migrationFiles = (await readdir(migrationsDirectory))
      .filter((file) => file.endsWith(".sql"))
      .sort();

    for (const migrationFile of migrationFiles) {
      const migrationSql = await readFile(new URL(migrationFile, migrationsDirectory), "utf8");
      await database.pool.query(migrationSql);
      logger.info({ migrationFile }, "database migration applied");
    }
  } finally {
    await database.close();
  }
};
