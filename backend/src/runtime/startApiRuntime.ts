import type { Express } from "express";
import type { Server } from "node:http";

import { createApp } from "../app/server/createApp.js";
import { buildDependencies } from "../app/server/dependencies.js";
import type { Env } from "../app/config/env.js";
import type { ApplicationModule } from "../app/composition/index.js";
import { runMigrations, type MigrationTimeoutOptions } from "../db/runMigrations.js";
import { createConnectorChatPort } from "../modules/connectors/services/public.js";
import { fetchPublicUrl } from "../shared/infra/http/publicUrlFetch.js";
import { createLogger, type AppLogger } from "../shared/observability/logger.js";
import type { AppDependencies } from "../app/server/types.js";
import type { RuntimeHandle } from "./types.js";
import { startRuntimeTracing, stopRuntimeTracing } from "./tracing.js";
import { runOpenAIResidencyStartupCheck } from "./openAIResidencyStartupCheck.js";

interface ServerLike {
  close(callback?: (error?: Error) => void): void;
}

interface StartApiRuntimeOptions {
  env: Env;
  logger?: AppLogger;
  runMigrations?: (connectionString: string, logger: AppLogger, options: MigrationTimeoutOptions) => Promise<void>;
  buildDependencies?: (env: Env) => AppDependencies;
  createApp?: (dependencies: AppDependencies) => Express;
  listen?: (app: Express, port: number, onListening: () => void) => ServerLike;
  applicationModules?: ApplicationModule[];
}

const defaultListen = (app: Express, port: number, onListening: () => void): Server =>
  app.listen(port, onListening);

export const startApiRuntime = async (options: StartApiRuntimeOptions): Promise<RuntimeHandle> => {
  const logger = options.logger ?? createLogger();
  startRuntimeTracing(options.env, logger, "api");
  const migrationOptions = {
    lockTimeoutMs: options.env.DB_MIGRATION_LOCK_TIMEOUT_MS,
    statementTimeoutMs: options.env.DB_MIGRATION_STATEMENT_TIMEOUT_MS,
  };
  logger.info({
    role: "api",
    migrationLockTimeoutMs: migrationOptions.lockTimeoutMs,
    migrationStatementTimeoutMs: migrationOptions.statementTimeoutMs,
  }, "Radioso API startup migrations starting");

  try {
    await (options.runMigrations ?? runMigrations)(options.env.DATABASE_URL, logger, migrationOptions);
  } catch (error) {
    logger.error({
      role: "api",
      migrationLockTimeoutMs: migrationOptions.lockTimeoutMs,
      migrationStatementTimeoutMs: migrationOptions.statementTimeoutMs,
      err: error,
    }, "Radioso API startup migrations failed");
    await stopRuntimeTracing();
    throw error;
  }

  const dependencies = options.buildDependencies
    ? options.buildDependencies(options.env)
    : buildDependencies(options.env, { modules: options.applicationModules });
  await runOpenAIResidencyStartupCheck(options.env, { logger: dependencies.logger });
  await dependencies.applicationModules.migrateAll(dependencies.connectorDb);
  await dependencies.connectorRegistry.runMigrations(dependencies.connectorDb);
  await dependencies.connectorRegistry.initializeAll({
    db: dependencies.connectorDb,
    logger: dependencies.logger,
    chat: createConnectorChatPort(dependencies.chatService, dependencies.conversationIngestService),
    ingestion: dependencies.connectorIngestionPort,
    approvalDecisionService: dependencies.approvalDecisionService,
    conversationOwnershipService: dependencies.conversationOwnershipService,
    // Slack operators are authorised by the same role and grant rules as the dashboard.
    operatorPermissions: dependencies.accountAccessService,
    auditService: dependencies.auditService,
    metricsRegistry: dependencies.metricsRegistry,
    workspaceInvalidationPublisher: dependencies.workspaceInvalidationPublisher,
    agentStarterPrompts: dependencies.agentStarterPromptReader,
    conversationLinks: dependencies.conversationLinks,
    assertPublicUrl: dependencies.assertPublicWebsiteUrl,
    fetchPublicUrl,
  });
  await dependencies.applicationModules.initializeAll();
  // Credential-expiry warnings and `registerPeriodicTask` contributions run from the worker
  // runtime, not here: this Cloud Run service has no CPU allocation once a request ends and
  // may run at zero instances, so a timer started in this process would stall or never fire.

  const app = (options.createApp ?? createApp)(dependencies);
  const server = (options.listen ?? defaultListen)(app, options.env.PORT, () => {
    dependencies.logger.info({ role: "api", port: options.env.PORT }, "Radioso API runtime listening");
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
      dependencies.logger.info({ role: "api", signal }, "Radioso API runtime shutting down");

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
            try {
              await dependencies.applicationModules.shutdownAll();
            } finally {
              try {
                await dependencies.closeApprovalResumeEffectJournal();
              } finally {
                await dependencies.closeAbuseControlRepository?.();
              }
            }
          } finally {
            try {
              await dependencies.connectorRegistry.shutdownAll();
            } finally {
              await stopRuntimeTracing();
            }
          }
        }
      }
    },
  };
};
