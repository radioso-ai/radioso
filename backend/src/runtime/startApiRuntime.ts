import type { Express } from "express";
import type { Server } from "node:http";

import { createApp } from "../app/server/createApp.js";
import { buildDependencies } from "../app/server/dependencies.js";
import type { Env } from "../app/config/env.js";
import type { ApplicationModule } from "../app/composition/index.js";
import { runMigrations } from "../db/runMigrations.js";
import { createConnectorChatPort } from "../modules/connectors/services/connectorChatPort.js";
import { createLogger, type AppLogger } from "../shared/observability/logger.js";
import type { AppDependencies } from "../app/server/types.js";
import type { RuntimeHandle } from "./types.js";

interface ServerLike {
  close(callback?: (error?: Error) => void): void;
}

export interface StartApiRuntimeOptions {
  env: Env;
  logger?: AppLogger;
  runMigrations?: (connectionString: string, logger: AppLogger) => Promise<void>;
  buildDependencies?: (env: Env) => AppDependencies;
  createApp?: (dependencies: AppDependencies) => Express;
  listen?: (app: Express, port: number, onListening: () => void) => ServerLike;
  applicationModules?: ApplicationModule[];
}

const defaultListen = (app: Express, port: number, onListening: () => void): Server =>
  app.listen(port, onListening);

export const startApiRuntime = async (options: StartApiRuntimeOptions): Promise<RuntimeHandle> => {
  const logger = options.logger ?? createLogger();
  await (options.runMigrations ?? runMigrations)(options.env.DATABASE_URL, logger);

  const dependencies = options.buildDependencies
    ? options.buildDependencies(options.env)
    : buildDependencies(options.env, { modules: options.applicationModules });
  await dependencies.connectorRegistry.runMigrations(dependencies.connectorDb);
  await dependencies.connectorRegistry.initializeAll({
    db: dependencies.connectorDb,
    logger: dependencies.logger,
    chat: createConnectorChatPort(dependencies.chatService),
  });
  await dependencies.applicationModules.initializeAll();

  const app = (options.createApp ?? createApp)(dependencies);
  const server = (options.listen ?? defaultListen)(app, options.env.PORT, () => {
    dependencies.logger.info({ role: "api", port: options.env.PORT }, "Radioso API runtime listening");
  });

  let shuttingDown = false;

  return {
    server: server as Server,
    async shutdown(signal: string) {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      dependencies.logger.info({ role: "api", signal }, "Radioso API runtime shutting down");

      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });

      await dependencies.applicationModules.shutdownAll();
      await dependencies.connectorRegistry.shutdownAll();
    },
  };
};
