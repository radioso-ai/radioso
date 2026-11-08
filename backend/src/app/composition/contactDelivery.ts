import {
  ConfiguredContactDeliveryResolver,
  OperatorNoticeDestinationsReader,
  WorkspaceOwnerContactRecipientResolver,
} from "../../modules/chat/composition.js";
import { AccountMembershipRepository } from "../../db/repositories/accountMembershipRepository.js";
import { AgentRepository } from "../../db/repositories/agentRepository.js";
import { ConversationRepository } from "../../db/repositories/conversationRepository.js";
import { WorkspaceRepository } from "../../db/repositories/workspaceRepository.js";
import { AgentSkillRepository } from "../../modules/agentSkills/repository.js";
import {
  NotificationDeliveryAdmissionService,
  NotificationDeliveryLog,
  NotificationDeliveryReader,
  NotificationRecipientConfirmationMailer,
  NotificationRecipientPolicyService,
  NotificationRecipientTokenSigner,
  UndeliveredRecipientAlerts,
  type NotificationRecipientPolicyPort,
} from "../../modules/operatorNotifications/public.js";
import {
  NotificationRecipientIdentityRepository,
  NotificationRecipientStateRepository,
} from "../../db/repositories/notificationRecipientStateRepository.js";
import { NotificationDeliveryOutcomeRepository } from "../../db/repositories/notificationDeliveryOutcomeRepository.js";
import { NotificationDeliveryRepository } from "../../db/repositories/notificationDeliveryRepository.js";
import { UndeliveredRecipientAlertRepository } from "../../db/repositories/undeliveredRecipientAlertRepository.js";
import { agentSkillsPermalink } from "../../shared/domain/dashboardLinks.js";
import type { Database } from "../../shared/infra/database.js";
import type { UsageLimitPolicy } from "../../shared/domain/usageLimitPolicy.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../shared/observability/metrics/metricsRegistry.js";
import type { Env } from "../config/env.js";
import type { MailTransportPort } from "./applicationModule.js";

export const notificationRecipientPublicApiBase = (env: Pick<Env, "APP_BASE_URL" | "CONNECTOR_PUBLIC_BASE_URL" | "PORT">): string => {
  if (env.CONNECTOR_PUBLIC_BASE_URL) return env.CONNECTOR_PUBLIC_BASE_URL.replace(/\/+$/u, "");
  if (env.APP_BASE_URL) return `${env.APP_BASE_URL.replace(/\/+$/u, "")}/backend`;
  return `http://localhost:${env.PORT}`;
};

/**
 * The one place the default contact destination is wired: a named notify skill, then
 * `contact_human`, then the agent's contact settings, then the workspace owner or admin.
 * Every sender of operator-facing email resolves recipients through this.
 */
export const buildContactDeliveryResolver = (database: Database): ConfiguredContactDeliveryResolver =>
  new ConfiguredContactDeliveryResolver(
    new ConversationRepository(database.kysely),
    new AgentRepository(database.kysely),
    new WorkspaceOwnerContactRecipientResolver(
      new WorkspaceRepository(database.kysely),
      new AccountMembershipRepository(database.kysely),
    ),
    new AgentSkillRepository(database.kysely),
  );

/** Shows an operator where a routine ending's notice goes, through the resolver that sends it. */
export const buildOperatorNoticeDestinationsReader = (
  database: Database,
  recipientPolicy: Pick<NotificationRecipientPolicyPort, "describe">,
  usageLimitPolicy: UsageLimitPolicy,
): OperatorNoticeDestinationsReader => {
  const skills = new AgentSkillRepository(database.kysely);
  return new OperatorNoticeDestinationsReader({
    skills: { listByAgent: (workspaceId, agentId) => skills.listByAgent(workspaceId, agentId) },
    resolver: buildContactDeliveryResolver(database),
    recipientPolicy,
    emailAllowance: new NotificationDeliveryAdmissionService(
      new NotificationDeliveryOutcomeRepository(database.kysely),
      usageLimitPolicy,
    ),
  });
};

export const buildNotificationRecipientPolicy = (input: {
  database: Database;
  env: Env;
  mailer: MailTransportPort;
  logger: AppLogger;
  metrics: MetricsRegistry | null;
  states?: NotificationRecipientStateRepository;
}): NotificationRecipientPolicyPort => {
  const states = input.states ?? new NotificationRecipientStateRepository(input.database.kysely);
  const signer = new NotificationRecipientTokenSigner(input.env.SESSION_COOKIE_SECRET);
  const confirmationMailer = new NotificationRecipientConfirmationMailer({
    mailer: input.mailer,
    signer,
    publicBaseUrl: notificationRecipientPublicApiBase(input.env),
    logger: input.logger,
    metrics: input.metrics,
  });
  return new NotificationRecipientPolicyService({
    enabled: input.env.NOTIFICATION_RECIPIENT_CONFIRMATION_ENABLED,
    states,
    sendConfirmation: async (request) => {
      if (!request.recipientId) throw new Error("Confirmation recipient state was not reserved");
      if (request.generation === undefined) throw new Error("Confirmation recipient generation was not reserved");
      return confirmationMailer.send({ ...request, recipientId: request.recipientId, generation: request.generation });
    },
    revocationUrl: (recipientId) => confirmationMailer.revocationUrl(recipientId),
    identity: new NotificationRecipientIdentityRepository(input.database.kysely),
    logger: input.logger,
    metrics: input.metrics,
  });
};

/** Reads the per-address record of notices for the dashboard, Ray and operator MCP. */
export const buildNotificationDeliveryReader = (database: Database): NotificationDeliveryReader =>
  new NotificationDeliveryReader(new NotificationDeliveryRepository(database.kysely));

/**
 * The one place the per-address record of notices is wired: the table behind it, and the alert that
 * emails the account's verified owners and admins when a notice skips an address they can still fix.
 * Both senders of operator-facing email take the result, so what is recorded and who is told never
 * differs between a contact request and a routine ending's notice.
 */
export const buildNotificationDeliveryRecorder = (input: {
  database: Database;
  env: Pick<Env, "APP_BASE_URL">;
  mailer: MailTransportPort;
  logger: AppLogger;
  metrics: MetricsRegistry | null;
  states?: NotificationRecipientStateRepository;
}): NotificationDeliveryLog => {
  const states = input.states ?? new NotificationRecipientStateRepository(input.database.kysely);
  const workspaces = new WorkspaceRepository(input.database.kysely);
  return new NotificationDeliveryLog({
    store: new NotificationDeliveryRepository(input.database.kysely),
    alerts: new UndeliveredRecipientAlerts({
      store: new UndeliveredRecipientAlertRepository(input.database.kysely, states),
      mailer: input.mailer,
      identity: new NotificationRecipientIdentityRepository(input.database.kysely),
      dashboardUrl: async ({ workspaceId, agentId }) => {
        const workspace = await workspaces.findById(workspaceId);
        return workspace
          ? agentSkillsPermalink({ workspacePublicRouteKey: workspace.publicRouteKey, agentId }, input.env.APP_BASE_URL)
          : null;
      },
      logger: input.logger,
      metrics: input.metrics,
    }),
    logger: input.logger,
    metrics: input.metrics,
  });
};
