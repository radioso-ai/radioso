import { buildDependencies } from "../app/server/dependencies.js";
import type { Env } from "../app/config/env.js";
import type { ApplicationModule } from "../app/composition/index.js";
import { ensureNoPendingMigrations } from "../db/runMigrations.js";
import { createLogger, type AppLogger } from "../shared/observability/logger.js";
import type { AppDependencies } from "../app/server/types.js";
import type { RuntimeHandle } from "./types.js";

export interface StartWorkerRuntimeOptions {
  env: Env;
  logger?: AppLogger;
  ensureNoPendingMigrations?: (connectionString: string) => Promise<void>;
  buildDependencies?: (env: Env) => AppDependencies;
  applicationModules?: ApplicationModule[];
}

export const startWorkerRuntime = async (options: StartWorkerRuntimeOptions): Promise<RuntimeHandle> => {
  const logger = options.logger ?? createLogger();
  await (options.ensureNoPendingMigrations ?? ensureNoPendingMigrations)(options.env.DATABASE_URL);

  const dependencies = options.buildDependencies
    ? options.buildDependencies(options.env)
    : buildDependencies(options.env, { modules: options.applicationModules });
  dependencies.logger.info({ role: "worker" }, "Radioso document worker starting");
  await dependencies.applicationModules.initializeAll();
  await dependencies.documentProcessingWorker.start();
  await dependencies.documentJobConsumer?.start();
  // Drain the async conversation-action outbox (spec 070) out of band from the turn.
  dependencies.actionDispatchWorker.start();

  let shuttingDown = false;

  return {
    async shutdown(signal: string) {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      dependencies.logger.info({ role: "worker", signal }, "Radioso document worker shutting down");
      await dependencies.actionDispatchWorker.stop();
      await dependencies.documentJobConsumer?.stop();
      await dependencies.documentProcessingWorker.stop();
      await dependencies.applicationModules.shutdownAll();
    },
  };
};
