import { existsSync } from "node:fs";

import { getEnv } from "./app/config/env.js";
import { createApp } from "./app/server/createApp.js";
import { buildDependencies } from "./app/server/dependencies.js";
import { runMigrations } from "./db/runMigrations.js";
import { createConnectorChatPort } from "./modules/connectors/services/connectorChatPort.js";
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
  chat: createConnectorChatPort(dependencies.chatService),
});
const app = createApp(dependencies);

await dependencies.documentProcessingWorker.start();

const server = app.listen(env.PORT, () => {
  dependencies.logger.info({ port: env.PORT }, "Hivec backend listening");
});

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  dependencies.logger.info({ signal }, "Hivec backend shutting down");
  server.close(() => {
    dependencies.logger.info({ signal }, "HTTP server closed");
  });
  await dependencies.documentProcessingWorker.stop();
  await dependencies.connectorRegistry.shutdownAll();
};

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});
