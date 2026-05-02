import type { Express } from "express";
import type { Server } from "node:http";

import type { Env } from "../app/config/env.js";
import type { AppDependencies } from "../app/server/types.js";
import { createWorkerTaskApp } from "../app/worker/createWorkerTaskApp.js";
import { buildDependencies } from "../app/server/dependencies.js";
import { ensureNoPendingMigrations } from "../db/runMigrations.js";
import { createLogger, type AppLogger } from "../shared/observability/logger.js";
import type { RuntimeHandle } from "./types.js";

interface ServerLike {
  close(callback?: (error?: Error) => void): void;
}

export interface StartWorkerTaskRuntimeOptions {
  env: Env;
  logger?: AppLogger;
  ensureNoPendingMigrations?: (connectionString: string) => Promise<void>;
  buildDependencies?: (env: Env) => AppDependencies;
  createApp?: (dependencies: AppDependencies) => Express;
  listen?: (app: Express, port: number, onListening: () => void) => ServerLike;
}

const defaultListen = (app: Express, port: number, onListening: () => void): Server =>
  app.listen(port, onListening);

export const startWorkerTaskRuntime = async (options: StartWorkerTaskRuntimeOptions): Promise<RuntimeHandle> => {
  const logger = options.logger ?? createLogger();
  await (options.ensureNoPendingMigrations ?? ensureNoPendingMigrations)(options.env.DATABASE_URL);

  const dependencies = (options.buildDependencies ?? buildDependencies)(options.env);
  dependencies.logger.info({ role: "worker-task" }, "Radioso worker task runtime starting");
  await dependencies.applicationModules.initializeAll();
  await dependencies.documentProcessingWorker.start();
  const app = (options.createApp ?? createWorkerTaskApp)(dependencies);
  const server = (options.listen ?? defaultListen)(app, options.env.PORT, () => {
    dependencies.logger.info({ role: "worker-task", port: options.env.PORT }, "Radioso worker task runtime listening");
  });

  let shuttingDown = false;

  return {
    server: server as Server,
    async shutdown(signal: string) {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      dependencies.logger.info({ role: "worker-task", signal }, "Radioso worker task runtime shutting down");
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      await dependencies.documentProcessingWorker.stop();
      await dependencies.applicationModules.shutdownAll();
    },
  };
};
