import { ApprovalResumeEffectJournalRepository } from "../../../db/repositories/approvalResumeEffectJournalRepository.js";
import { CopilotRetentionWorker } from "../../../modules/operatorCopilot/public.js";
import { PostgresSlackInboundEventRetention } from "../../../modules/slack/public.js";
import { TtlRetentionWorker } from "../../../shared/domain/ttlRetentionWorker.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type { Env } from "../../config/env.js";
import type { buildInfrastructure, buildRepositories } from "./infra.js";

/**
 * Retention runs in the worker process: it is periodic maintenance with no request behind it,
 * and the HTTP process must not do it once per replica. The revision eval-run sweep is built
 * with the eval services, which own its repository.
 */
export const buildRetentionWorkers = (input: {
  env: Pick<
    Env,
    "COPILOT_CONVERSATION_RETENTION_DAYS" | "AGENT_TEST_EXECUTION_RETENTION_DAYS" | "SLACK_INBOUND_EVENT_RETENTION_DAYS"
  >;
  infrastructure: Pick<ReturnType<typeof buildInfrastructure>, "auditService" | "database">;
  logger: AppLogger;
  repositories: Pick<ReturnType<typeof buildRepositories>, "copilotRepository" | "testExecutionRepository">;
}) => {
  const { env, infrastructure, logger, repositories } = input;
  const copilotRetentionWorker = new CopilotRetentionWorker({
    retention: repositories.copilotRepository,
    audit: infrastructure.auditService,
    logger,
    retentionDays: env.COPILOT_CONVERSATION_RETENTION_DAYS,
  });
  const testExecutionRetentionWorker = new TtlRetentionWorker({
    subject: "agent_test_execution",
    sweep: { deleteBefore: (sweepInput) => repositories.testExecutionRepository.deleteExecutionsUpdatedBefore(sweepInput) },
    audit: infrastructure.auditService,
    logger,
    retentionDays: env.AGENT_TEST_EXECUTION_RETENTION_DAYS,
  });
  const approvalResumeEffectJournalRetentionWorker = new TtlRetentionWorker({
    subject: "approval_resume_effect_journal",
    sweep: new ApprovalResumeEffectJournalRepository(infrastructure.database.kysely),
    audit: infrastructure.auditService,
    logger,
    retentionDays: 30,
  });
  // Slack event ids exist only to deduplicate redelivery; channel subscriptions write one per
  // message in every joined channel, so the ledger is swept on the same timer machinery.
  const slackInboundEventRetentionWorker = new TtlRetentionWorker({
    subject: "slack_inbound_event",
    sweep: new PostgresSlackInboundEventRetention(infrastructure.database.kysely),
    audit: infrastructure.auditService,
    logger,
    retentionDays: env.SLACK_INBOUND_EVENT_RETENTION_DAYS,
  });
  return {
    copilotRetentionWorker,
    testExecutionRetentionWorker,
    approvalResumeEffectJournalRetentionWorker,
    slackInboundEventRetentionWorker,
  };
};
