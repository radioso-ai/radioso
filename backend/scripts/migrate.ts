import { getEnv } from "../src/app/config/env.js";
import { runMigrations } from "../src/db/runMigrations.js";
import { createLogger } from "../src/shared/observability/logger.js";

/**
 * Applies pending SQL migrations against DATABASE_URL. Migrations otherwise run only on
 * server startup; this standalone entry lets CI (and the conversation-quality eval
 * workflow) provision a fresh database before starting the document worker or the suite.
 */
const main = async (): Promise<void> => {
  const env = getEnv();
  await runMigrations(env.DATABASE_URL, createLogger("silent"));
  console.log("Migrations applied.");
};

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
