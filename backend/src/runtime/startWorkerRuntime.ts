import { buildDependencies } from "../app/server/dependencies.js";
import type { Env } from "../app/config/env.js";
import type { ApplicationModule } from "../app/composition/index.js";
import { ensureNoPendingMigrations, type MigrationTimeoutOptions } from "../db/runMigrations.js";
import { createLogger, type AppLogger } from "../shared/observability/logger.js";
import type { AppDependencies } from "../app/server/types.js";
import type { RuntimeHandle } from "./types.js";
import { startRuntimeTracing, stopRuntimeTracing } from "./tracing.js";

export interface StartWorkerRuntimeOptions {
  env: Env;
  logger?: AppLogger;
  ensureNoPendingMigrations?: (connectionString: string, options: MigrationTimeoutOptions) => Promise<void>;
  buildDependencies?: (env: Env) => AppDependencies;
  applicationModules?: ApplicationModule[];
}

export const startWorkerRuntime = async (options: StartWorkerRuntimeOptions): Promise<RuntimeHandle> => {
  const logger = options.logger ?? createLogger();
  await (options.ensureNoPendingMigrations ?? ensureNoPendingMigrations)(options.env.DATABASE_URL, {
    lockTimeoutMs: options.env.DB_MIGRATION_LOCK_TIMEOUT_MS,
    statementTimeoutMs: options.env.DB_MIGRATION_STATEMENT_TIMEOUT_MS,
  });
  startRuntimeTracing(options.env, logger, "document-worker");

  const dependencies = options.buildDependencies
    ? options.buildDependencies(options.env)
    : buildDependencies(options.env, { modules: options.applicationModules });
  dependencies.logger.info({ role: "worker" }, "Radioso document worker starting");
  await dependencies.applicationModules.initializeAll();
  dependencies.vectorIndexReconciler?.start();
  await dependencies.documentProcessingWorker.start();
  await dependencies.documentJobConsumer?.start();
  // Drain per-message facet extraction for the topic census. Batch analytics: the poll
  // loop is the whole transport, and it is absent unless an extractor is registered.
  dependencies.facetExtractionWorker?.start();
  // Drain the async conversation-action outbox (spec 070) out of band from the turn.
  dependencies.actionDispatchWorker.start();
  // Enforce the copilot conversation retention window. Started last and stopped first: it owns no
  // queue, so a shutdown that skips a sweep loses nothing but a few hours of lateness.
  dependencies.copilotRetentionWorker.start();
  dependencies.agentBundleImportCleanupWorker.start();

  let shuttingDown = false;

  return {
    errorReporter: dependencies.errorReportingService,
    logger: dependencies.logger,
    async shutdown(signal: string) {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      dependencies.logger.info({ role: "worker", signal }, "Radioso document worker shutting down");
      try {
        await dependencies.copilotRetentionWorker.stop();
        await dependencies.agentBundleImportCleanupWorker.stop();
        await dependencies.actionDispatchWorker.stop();
        await dependencies.facetExtractionWorker?.stop();
        await dependencies.documentJobConsumer?.stop();
        await dependencies.documentProcessingWorker.stop();
        await dependencies.vectorIndexReconciler?.stop();
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
