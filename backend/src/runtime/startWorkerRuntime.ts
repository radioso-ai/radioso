import { buildDependencies } from "../app/server/dependencies.js";
import type { Env } from "../app/config/env.js";
import { ensureNoPendingMigrations } from "../db/runMigrations.js";
import { createLogger, type AppLogger } from "../shared/observability/logger.js";
import type { AppDependencies } from "../app/server/types.js";
import type { RuntimeHandle } from "./types.js";

export interface StartWorkerRuntimeOptions {
  env: Env;
  logger?: AppLogger;
  ensureNoPendingMigrations?: (connectionString: string) => Promise<void>;
  buildDependencies?: (env: Env) => AppDependencies;
}

export const startWorkerRuntime = async (options: StartWorkerRuntimeOptions): Promise<RuntimeHandle> => {
  const logger = options.logger ?? createLogger();
  await (options.ensureNoPendingMigrations ?? ensureNoPendingMigrations)(options.env.DATABASE_URL);

  const dependencies = (options.buildDependencies ?? buildDependencies)(options.env);
  dependencies.logger.info({ role: "worker" }, "Radioso document worker starting");
  await dependencies.applicationModules.initializeAll();
  await dependencies.documentProcessingWorker.start();

  let shuttingDown = false;

  return {
    async shutdown(signal: string) {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      dependencies.logger.info({ role: "worker", signal }, "Radioso document worker shutting down");
      await dependencies.documentProcessingWorker.stop();
      await dependencies.applicationModules.shutdownAll();
    },
  };
};
