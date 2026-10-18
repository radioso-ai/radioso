import type { Express } from "express";
import type { Server } from "node:http";

import type { Env } from "../app/config/env.js";
import type { AppDependencies } from "../app/server/types.js";
import type { ApplicationModule } from "../app/composition/index.js";
import { createWorkerTaskApp } from "../app/worker/createWorkerTaskApp.js";
import { buildDependencies } from "../app/server/dependencies.js";
import { ensureNoPendingMigrations, type MigrationTimeoutOptions } from "../db/runMigrations.js";
import { createLogger, type AppLogger } from "../shared/observability/logger.js";
import type { RuntimeHandle } from "./types.js";
import { startRuntimeTracing, stopRuntimeTracing } from "./tracing.js";
import { runOpenAIResidencyStartupCheck } from "./openAIResidencyStartupCheck.js";

interface ServerLike {
  close(callback?: (error?: Error) => void): void;
}

interface StartWorkerTaskRuntimeOptions {
  env: Env;
  logger?: AppLogger;
  ensureNoPendingMigrations?: (
    connectionString: string,
    options: MigrationTimeoutOptions,
    logger?: AppLogger,
  ) => Promise<void>;
  buildDependencies?: (env: Env) => AppDependencies;
  createApp?: (dependencies: AppDependencies) => Express;
  listen?: (app: Express, port: number, onListening: () => void) => ServerLike;
  applicationModules?: ApplicationModule[];
}

const defaultListen = (app: Express, port: number, onListening: () => void): Server =>
  app.listen(port, onListening);

export const startWorkerTaskRuntime = async (options: StartWorkerTaskRuntimeOptions): Promise<RuntimeHandle> => {
  const logger = options.logger ?? createLogger();
  await (options.ensureNoPendingMigrations ?? ensureNoPendingMigrations)(options.env.DATABASE_URL, {
    lockTimeoutMs: options.env.DB_MIGRATION_LOCK_TIMEOUT_MS,
    statementTimeoutMs: options.env.DB_MIGRATION_STATEMENT_TIMEOUT_MS,
  }, logger);
  startRuntimeTracing(options.env, logger, "document-worker-task-server");

  const dependencies = options.buildDependencies
    ? options.buildDependencies(options.env)
    : buildDependencies(options.env, { modules: options.applicationModules });
  dependencies.logger.info({ role: "worker-task" }, "Radioso worker task runtime starting");
  await runOpenAIResidencyStartupCheck(options.env, { logger: dependencies.logger });
  await dependencies.applicationModules.initializeAll();
  const app = (options.createApp ?? createWorkerTaskApp)(dependencies);
  const server = (options.listen ?? defaultListen)(app, options.env.PORT, () => {
    dependencies.logger.info({ role: "worker-task", port: options.env.PORT }, "Radioso worker task runtime listening");
  });

  let shuttingDown = false;

  return {
    server: server as Server,
    errorReporter: dependencies.errorReportingService,
    logger: dependencies.logger,
    async shutdown(signal: string) {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      dependencies.logger.info({ role: "worker-task", signal }, "Radioso worker task runtime shutting down");
      try {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        });
      } finally {
        try {
          await dependencies.realtimePublisherLifecycle.shutdown();
        } finally {
          try {
            await dependencies.applicationModules.shutdownAll();
          } finally {
            await stopRuntimeTracing();
          }
        }
      }
    },
  };
};
