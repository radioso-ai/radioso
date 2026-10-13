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
  NotificationRecipientConfirmationMailer,
  NotificationRecipientPolicyService,
  NotificationRecipientTokenSigner,
  type NotificationRecipientPolicyPort,
} from "../../modules/operatorNotifications/public.js";
import {
  NotificationRecipientIdentityRepository,
  NotificationRecipientStateRepository,
} from "../../db/repositories/notificationRecipientStateRepository.js";
import type { Database } from "../../shared/infra/database.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../shared/observability/metrics/metricsRegistry.js";
import type { Env } from "../config/env.js";
import type { MailTransportPort } from "./applicationModule.js";

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
  recipientPolicy?: Pick<NotificationRecipientPolicyPort, "describe">,
): OperatorNoticeDestinationsReader => {
  const skills = new AgentSkillRepository(database.kysely);
  return new OperatorNoticeDestinationsReader({
    skills: { listByAgent: (workspaceId, agentId) => skills.listByAgent(workspaceId, agentId) },
    resolver: buildContactDeliveryResolver(database),
    recipientPolicy,
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
    publicBaseUrl: input.env.CONNECTOR_PUBLIC_BASE_URL
      ?? input.env.APP_BASE_URL
      ?? `http://localhost:${input.env.PORT}`,
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
    revocationUrl: (recipientId, generation) => confirmationMailer.revocationUrl(recipientId, generation),
    identity: new NotificationRecipientIdentityRepository(input.database.kysely),
    logger: input.logger,
    metrics: input.metrics,
  });
};
