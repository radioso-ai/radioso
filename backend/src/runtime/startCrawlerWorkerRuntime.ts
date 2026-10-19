import { buildDependencies } from "../app/server/dependencies.js";
import type { Env } from "../app/config/env.js";
import type { ApplicationModule } from "../app/composition/index.js";
import { ensureNoPendingMigrations, type MigrationTimeoutOptions } from "../db/runMigrations.js";
import { createLogger, type AppLogger } from "../shared/observability/logger.js";
import type { AppDependencies } from "../app/server/types.js";
import type { RuntimeHandle } from "./types.js";
import { startRuntimeTracing, stopRuntimeTracing } from "./tracing.js";
import { runOpenAIResidencyStartupCheck } from "./openAIResidencyStartupCheck.js";

interface StartCrawlerWorkerRuntimeOptions {
  env: Env;
  logger?: AppLogger;
  ensureNoPendingMigrations?: (
    connectionString: string,
    options: MigrationTimeoutOptions,
    logger?: AppLogger,
  ) => Promise<void>;
  buildDependencies?: (env: Env) => AppDependencies;
  applicationModules?: ApplicationModule[];
}

export const startCrawlerWorkerRuntime = async (
  options: StartCrawlerWorkerRuntimeOptions,
): Promise<RuntimeHandle> => {
  const logger = options.logger ?? createLogger();
  await (options.ensureNoPendingMigrations ?? ensureNoPendingMigrations)(options.env.DATABASE_URL, {
    lockTimeoutMs: options.env.DB_MIGRATION_LOCK_TIMEOUT_MS,
    statementTimeoutMs: options.env.DB_MIGRATION_STATEMENT_TIMEOUT_MS,
  }, logger);
  startRuntimeTracing(options.env, logger, "crawler-worker");

  const dependencies = options.buildDependencies
    ? options.buildDependencies(options.env)
    : buildDependencies(options.env, { modules: options.applicationModules });
  dependencies.logger.info({ role: "crawler-worker" }, "Radioso crawler worker starting");
  await runOpenAIResidencyStartupCheck(options.env, { logger: dependencies.logger });
  await dependencies.applicationModules.initializeAll();
  await dependencies.websiteCrawlWorker.start();
  await dependencies.websiteCrawlJobConsumer?.start();

  let shuttingDown = false;

  return {
    errorReporter: dependencies.errorReportingService,
    logger: dependencies.logger,
    async shutdown(signal: string) {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      dependencies.logger.info({ role: "crawler-worker", signal }, "Radioso crawler worker shutting down");
      try {
        await dependencies.websiteCrawlJobConsumer?.stop();
        await dependencies.websiteCrawlWorker.stop();
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
