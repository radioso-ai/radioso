import type { WorkspaceInvalidationPublisher } from "@radioso/workspace-invalidation-contract";

import { ActionRequestRepository } from "../../../../db/repositories/actionRequestRepository.js";
import type { ChatAnswerPort, ConversationIngestPort } from "../../../chat/contracts/index.js";
import { createConnectorChatPort } from "../../services/public.js";
import type {
  SlackBindingRepositoryPort,
  SlackInstallationRepositoryPort,
  SlackInstallationService,
} from "../../../slack/public.js";
import type { BackgroundJobHandlerRegistration } from "../../../../shared/background-jobs/index.js";
import type { ConversationLinkResolver } from "../../../../shared/domain/conversationLinkResolver.js";
import type { Db } from "../../../../shared/infra/kysely/types.js";
import type { AppLogger } from "../../../../shared/observability/logger.js";
import { SlackMessageHandler, type SlackWebApiClientFactory } from "./slackMessageHandler.js";
import { PostgresSlackPersistence, type SlackPersistencePort } from "./slackPersistence.js";
import { createSlackInboundEventJobHandler } from "./slackInboundEventJob.js";
import type { SlackStarterPromptsPort } from "./slackAgentSession.js";

/**
 * Builds the Slack message handler the worker dispatches `slack.inbound_event` jobs through, and
 * the handler registration `backgroundJobs.createRuntime` runs it under. Registered unconditionally
 * (not gated on Slack readiness): it needs none of `SLACK_SIGNING_SECRET` or the OAuth client
 * credentials (those only verify the webhook and drive the install flow, both API-only), and bot
 * tokens come from the database per installation. A deployment with no Slack installation simply
 * never enqueues this kind, so an idle handler costs nothing.
 */
export const buildSlackInboundJobComposition = (input: {
  db: Db;
  logger: AppLogger;
  chatService: ChatAnswerPort;
  conversationIngestService: ConversationIngestPort;
  slackInstallationService: Pick<SlackInstallationService, "resolveBotTokenForInstallation" | "markNeedsReauthForInstallation">;
  installations: SlackInstallationRepositoryPort;
  bindings: SlackBindingRepositoryPort;
  workspaceInvalidationPublisher?: WorkspaceInvalidationPublisher;
  starterPrompts?: SlackStarterPromptsPort;
  conversationLinks?: ConversationLinkResolver;
  /** Override for tests that want to drive a real dispatch without a Postgres connection. */
  persistence?: SlackPersistencePort;
  /** Override for tests that want to drive a real dispatch without calling the Slack Web API. */
  clientFactory?: SlackWebApiClientFactory;
}): { backgroundJobHandlers: readonly BackgroundJobHandlerRegistration[] } => {
  const persistence = input.persistence ?? new PostgresSlackPersistence(input.db);
  const messageHandler = new SlackMessageHandler({
    logger: input.logger,
    chat: createConnectorChatPort(input.chatService, input.conversationIngestService),
    installations: input.installations,
    bindings: input.bindings,
    installationService: input.slackInstallationService,
    persistence,
    slackPostOutbox: new ActionRequestRepository(input.db),
    workspaceInvalidationPublisher: input.workspaceInvalidationPublisher,
    starterPrompts: input.starterPrompts,
    conversationLinks: input.conversationLinks,
    clientFactory: input.clientFactory,
  });
  return {
    backgroundJobHandlers: [createSlackInboundEventJobHandler(messageHandler, persistence, input.logger)],
  };
};
