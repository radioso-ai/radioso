import { buildDependencies } from "../app/server/dependencies.js";
import type { Env } from "../app/config/env.js";
import type { ApplicationModule } from "../app/composition/index.js";
import { ensureNoPendingMigrations, type MigrationTimeoutOptions } from "../db/runMigrations.js";
import { createLogger, type AppLogger } from "../shared/observability/logger.js";
import type { AppDependencies } from "../app/server/types.js";
import type { RuntimeHandle } from "./types.js";
import { startRuntimeTracing, stopRuntimeTracing } from "./tracing.js";

interface StartWorkerRuntimeOptions {
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

export const startWorkerRuntime = async (options: StartWorkerRuntimeOptions): Promise<RuntimeHandle> => {
  const logger = options.logger ?? createLogger();
  await (options.ensureNoPendingMigrations ?? ensureNoPendingMigrations)(options.env.DATABASE_URL, {
    lockTimeoutMs: options.env.DB_MIGRATION_LOCK_TIMEOUT_MS,
    statementTimeoutMs: options.env.DB_MIGRATION_STATEMENT_TIMEOUT_MS,
  }, logger);
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
  dependencies.facetExtractionBackgroundJobRuntime?.start();
  // Drain the async conversation-action outbox (spec 070) out of band from the turn, through the
  // generic background-job runtime (#1509).
  dependencies.actionDispatchJobRuntime.start();
  await dependencies.actionOutboxQueueDepthReporter.start();
  // Run durable background jobs (`background_jobs`): conversation summary refresh and any other
  // kind a module registers.
  dependencies.backgroundJobRuntime.start();
  // Drain the email channel's inbound work and run its sweep; present only when a provider is
  // configured, and idle unless EMAIL_CHANNEL_WORKERS_ENABLED.
  dependencies.emailChannelWorker?.start();
  // Enforce the copilot conversation retention window. Started last and stopped first: it owns no
  // queue, so a shutdown that skips a sweep loses nothing but a few hours of lateness.
  dependencies.copilotRetentionWorker.start();
  dependencies.testExecutionRetentionWorker.start();
  dependencies.approvalResumeEffectJournalRetentionWorker.start();
  dependencies.revisionEvalRunRetentionWorker.start();
  dependencies.slackInboundEventRetentionWorker.start();
  dependencies.agentBundleImportCleanupWorker.start();
  dependencies.backgroundJobRetentionWorker.start();
  // Credential-expiry warnings and every `registerPeriodicTask` contribution (e.g. EE's
  // usage-alert sweep) run here rather than in the API runtime: this poll loop always has a
  // live process behind it, while the API Cloud Run service has no CPU allocation once a
  // request ends and may run at zero instances. The production push worker instead drives the
  // same tasks from a Cloud Scheduler-pushed route (`documentWorkerTaskRoutes.ts`).
  await dependencies.credentialExpiryWarningLifecycle.start();
  await dependencies.periodicTasksLifecycle.start();

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
        await dependencies.credentialExpiryWarningLifecycle.stop();
        await dependencies.periodicTasksLifecycle.stop();
        await dependencies.backgroundJobRetentionWorker.stop();
        await dependencies.copilotRetentionWorker.stop();
        await dependencies.testExecutionRetentionWorker.stop();
        await dependencies.approvalResumeEffectJournalRetentionWorker.stop();
        await dependencies.revisionEvalRunRetentionWorker.stop();
        await dependencies.slackInboundEventRetentionWorker.stop();
        await dependencies.agentBundleImportCleanupWorker.stop();
        await dependencies.emailChannelWorker?.stop();
        await dependencies.backgroundJobRuntime.stop();
        await dependencies.actionOutboxQueueDepthReporter.stop();
        await dependencies.actionDispatchJobRuntime.stop();
        await dependencies.facetExtractionBackgroundJobRuntime?.stop();
        await dependencies.documentJobConsumer?.stop();
        await dependencies.documentProcessingWorker.stop();
        await dependencies.vectorIndexReconciler?.stop();
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
            await stopRuntimeTracing();
          }
        }
      }
    },
  };
};
