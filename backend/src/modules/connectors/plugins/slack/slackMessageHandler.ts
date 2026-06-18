import type {
  ConnectorChatPort,
  ConnectorLogger,
} from "@radioso/connector-api";

import {
  SlackWebApiClient,
  type SlackWebApiClientOptions,
  type SlackWebApiClient as SlackWebApiClientInstance,
  type SlackBindingRepositoryPort,
  type SlackInstallationRecord,
  type SlackInstallationRepositoryPort,
  type SlackInstallationService,
} from "../../../slack/public.js";
import type { SlackPersistencePort } from "./slackPersistence.js";

export interface SlackMessageImEvent {
  type: "message";
  channel_type: "im";
  channel: string;
  user: string;
  text: string;
  ts?: string;
  bot_id?: string;
}

export interface SlackInboundEventEnvelope {
  eventId: string;
  teamId: string;
  event: SlackMessageImEvent;
}

export type SlackWebApiClientFactory = (
  options: Pick<SlackWebApiClientOptions, "botToken">,
) => Pick<SlackWebApiClientInstance, "postMessage">;

export interface SlackMessageHandlerOptions {
  logger: ConnectorLogger;
  chat: ConnectorChatPort;
  installations: SlackInstallationRepositoryPort;
  bindings: SlackBindingRepositoryPort;
  installationService: Pick<SlackInstallationService, "resolveBotTokenForInstallation">;
  persistence: SlackPersistencePort;
  clientFactory?: SlackWebApiClientFactory;
}

const dmSlackKey = (teamId: string, userId: string): string => `dm:${teamId}:${userId}`;

export class SlackMessageHandler {
  private readonly clientFactory: SlackWebApiClientFactory;

  constructor(private readonly options: SlackMessageHandlerOptions) {
    this.clientFactory = options.clientFactory ?? ((clientOptions) => new SlackWebApiClient(clientOptions));
  }

  async handleMessageIm(input: SlackInboundEventEnvelope): Promise<void> {
    const installation = await this.options.installations.findByTeamId(input.teamId);
    if (!installation) {
      await this.options.persistence.markInboundEventStatus(input.eventId, "skipped");
      this.options.logger.info({ teamId: input.teamId, eventId: input.eventId }, "Slack inbound skipped without installation");
      return;
    }

    const binding = await this.options.bindings.findByInstallationId(installation.id);
    if (!binding?.answeringAgentId) {
      await this.options.persistence.markInboundEventStatus(input.eventId, "skipped");
      this.options.logger.info(
        { workspaceId: installation.workspaceId, installationId: installation.id, eventId: input.eventId },
        "Slack inbound skipped without answering agent binding",
      );
      return;
    }

    const query = input.event.text.trim();
    if (!query) {
      await this.options.persistence.markInboundEventStatus(input.eventId, "skipped");
      return;
    }

    const slackKey = dmSlackKey(input.teamId, input.event.user);
    const existingLink = await this.options.persistence.findConversationLink({
      workspaceId: installation.workspaceId,
      slackKey,
    });

    this.options.logger.info(
      { workspaceId: installation.workspaceId, installationId: installation.id, eventId: input.eventId },
      "Slack turn dispatch started",
    );
    const response = await this.options.chat.answer({
      workspaceId: installation.workspaceId,
      conversationId: existingLink?.conversationId,
      query,
      sourceChannel: "slack",
    });
    await this.options.persistence.upsertConversationLink({
      workspaceId: installation.workspaceId,
      installationId: installation.id,
      slackKey,
      conversationId: response.conversationId,
    });

    const botToken = await this.options.installationService.resolveBotTokenForInstallation(installation);
    if (!botToken) {
      await this.options.persistence.markInboundEventStatus(input.eventId, "skipped");
      this.options.logger.warn(
        { workspaceId: installation.workspaceId, installationId: installation.id, eventId: input.eventId },
        "Slack reply skipped without bot token",
      );
      return;
    }

    await this.clientFactory({ botToken }).postMessage({
      channel: input.event.channel,
      text: response.answer,
    });
    await this.options.persistence.markInboundEventStatus(input.eventId, "processed");
    this.options.logger.info(
      { workspaceId: installation.workspaceId, installationId: installation.id, eventId: input.eventId },
      "Slack reply delivered",
    );
  }

  isBotLoop(installation: SlackInstallationRecord | null, event: { user?: unknown; bot_id?: unknown }): boolean {
    if (typeof event.bot_id === "string" && event.bot_id.length > 0) {
      return true;
    }
    return Boolean(installation?.botUserId && event.user === installation.botUserId);
  }
}
