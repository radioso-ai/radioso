import type { Express } from "express";
import type { Server } from "node:http";

import type { Env } from "../app/config/env.js";
import type { AppDependencies } from "../app/server/types.js";
import { createCrawlerWorkerTaskApp } from "../app/worker/createCrawlerWorkerTaskApp.js";
import { buildDependencies } from "../app/server/dependencies.js";
import { ensureNoPendingMigrations } from "../db/runMigrations.js";
import { createLogger, type AppLogger } from "../shared/observability/logger.js";
import type { RuntimeHandle } from "./types.js";

interface ServerLike {
  close(callback?: (error?: Error) => void): void;
}

export interface StartCrawlerWorkerTaskRuntimeOptions {
  env: Env;
  logger?: AppLogger;
  ensureNoPendingMigrations?: (connectionString: string) => Promise<void>;
  buildDependencies?: (env: Env) => AppDependencies;
  createApp?: (dependencies: AppDependencies) => Express;
  listen?: (app: Express, port: number, onListening: () => void) => ServerLike;
}

const defaultListen = (app: Express, port: number, onListening: () => void): Server =>
  app.listen(port, onListening);

export const startCrawlerWorkerTaskRuntime = async (
  options: StartCrawlerWorkerTaskRuntimeOptions,
): Promise<RuntimeHandle> => {
  const logger = options.logger ?? createLogger();
  await (options.ensureNoPendingMigrations ?? ensureNoPendingMigrations)(options.env.DATABASE_URL);

  const dependencies = (options.buildDependencies ?? buildDependencies)(options.env);
  dependencies.logger.info({ role: "crawler-worker-task" }, "Radioso crawler worker task runtime starting");
  await dependencies.applicationModules.initializeAll();
  await dependencies.websiteCrawlWorker.start();
  await dependencies.websiteCrawlJobConsumer?.start();
  const app = (options.createApp ?? createCrawlerWorkerTaskApp)(dependencies);
  const server = (options.listen ?? defaultListen)(app, options.env.PORT, () => {
    dependencies.logger.info(
      { role: "crawler-worker-task", port: options.env.PORT },
      "Radioso crawler worker task runtime listening",
    );
  });

  let shuttingDown = false;

  return {
    server: server as Server,
    async shutdown(signal: string) {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      dependencies.logger.info({ role: "crawler-worker-task", signal }, "Radioso crawler worker task runtime shutting down");
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      await dependencies.websiteCrawlJobConsumer?.stop();
      await dependencies.websiteCrawlWorker.stop();
      await dependencies.applicationModules.shutdownAll();
    },
  };
};
