import { buildDependencies } from "../app/server/dependencies.js";
import type { Env } from "../app/config/env.js";
import type { ApplicationModule } from "../app/composition/index.js";
import { ensureNoPendingMigrations } from "../db/runMigrations.js";
import { createLogger, type AppLogger } from "../shared/observability/logger.js";
import type { AppDependencies } from "../app/server/types.js";
import type { RuntimeHandle } from "./types.js";

export interface StartCrawlerWorkerRuntimeOptions {
  env: Env;
  logger?: AppLogger;
  ensureNoPendingMigrations?: (connectionString: string) => Promise<void>;
  buildDependencies?: (env: Env) => AppDependencies;
  applicationModules?: ApplicationModule[];
}

export const startCrawlerWorkerRuntime = async (
  options: StartCrawlerWorkerRuntimeOptions,
): Promise<RuntimeHandle> => {
  const logger = options.logger ?? createLogger();
  await (options.ensureNoPendingMigrations ?? ensureNoPendingMigrations)(options.env.DATABASE_URL);

  const dependencies = options.buildDependencies
    ? options.buildDependencies(options.env)
    : buildDependencies(options.env, { modules: options.applicationModules });
  dependencies.logger.info({ role: "crawler-worker" }, "Radioso crawler worker starting");
  await dependencies.applicationModules.initializeAll();
  await dependencies.websiteCrawlWorker.start();
  await dependencies.websiteCrawlJobConsumer?.start();

  let shuttingDown = false;

  return {
    async shutdown(signal: string) {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      dependencies.logger.info({ role: "crawler-worker", signal }, "Radioso crawler worker shutting down");
      await dependencies.websiteCrawlJobConsumer?.stop();
      await dependencies.websiteCrawlWorker.stop();
      await dependencies.applicationModules.shutdownAll();
    },
  };
};
