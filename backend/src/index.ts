import { existsSync } from "node:fs";

import { getEnv } from "./app/config/env.js";
import { createApp } from "./app/server/createApp.js";
import { buildDependencies } from "./app/server/dependencies.js";
import { runMigrations } from "./db/runMigrations.js";
import { createLogger } from "./shared/observability/logger.js";

if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

const env = getEnv();
const startupLogger = createLogger();

await runMigrations(env.DATABASE_URL, startupLogger);

const dependencies = buildDependencies(env);
await dependencies.connectorRegistry.runMigrations(dependencies.connectorDb);
await dependencies.connectorRegistry.initializeAll({
  db: dependencies.connectorDb,
  logger: dependencies.logger,
  chatService: dependencies.chatService,
  connectorRegistry: dependencies.connectorRegistry,
  router: dependencies.connectorRegistry.getRouter(),
});
const app = createApp(dependencies);

await dependencies.documentProcessingWorker.start();

app.listen(env.PORT, () => {
  dependencies.logger.info({ port: env.PORT }, "Hivec backend listening");
});
