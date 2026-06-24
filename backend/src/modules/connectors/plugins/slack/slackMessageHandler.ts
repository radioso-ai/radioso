import type {
  ConnectorChatPort,
  ConnectorLogger,
} from "@radioso/connector-api";
import type { ConversationChannelContext } from "@radioso/conversation-contract";

import {
  SlackWebApiClient,
  postSlackText,
  slackAuthErrorCode,
  type SlackWebApiClientOptions,
  type SlackWebApiClient as SlackWebApiClientInstance,
  type SlackBindingRepositoryPort,
  type SlackInstallationRecord,
  type SlackInstallationRepositoryPort,
  type SlackInstallationService,
  enqueueSlackPostAction,
  slackPostIdempotencyKey,
  type SlackPostOutboxPort,
  buildOwnershipMessage,
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

export interface SlackAppMentionEvent {
  type: "app_mention";
  channel: string;
  user: string;
  text: string;
  ts: string;
  thread_ts?: string;
  bot_id?: string;
}

export interface SlackInboundEventEnvelope {
  eventId: string;
  teamId: string;
  event: SlackMessageImEvent | SlackAppMentionEvent;
}

export type SlackWebApiClientFactory = (
  options: Pick<SlackWebApiClientOptions, "botToken">,
) => Pick<SlackWebApiClientInstance, "postMessage">;

export interface SlackMessageHandlerOptions {
  logger: ConnectorLogger;
  chat: ConnectorChatPort;
  installations: SlackInstallationRepositoryPort;
  bindings: SlackBindingRepositoryPort;
  installationService: Pick<SlackInstallationService, "markNeedsReauthForInstallation" | "resolveBotTokenForInstallation">;
  persistence: SlackPersistencePort;
  slackPostOutbox?: SlackPostOutboxPort;
  clientFactory?: SlackWebApiClientFactory;
}

const dmSlackKey = (teamId: string, userId: string): string => `dm:${teamId}:${userId}`;
const mentionSlackKey = (teamId: string, channelId: string, threadTs: string): string =>
  `mention:${teamId}:${channelId}:${threadTs}`;

export class SlackMessageHandler {
  private readonly clientFactory: SlackWebApiClientFactory;

  constructor(private readonly options: SlackMessageHandlerOptions) {
    this.clientFactory = options.clientFactory ?? ((clientOptions) => new SlackWebApiClient(clientOptions));
  }

  async handleMessageIm(input: SlackInboundEventEnvelope): Promise<void> {
    if (input.event.type !== "message") {
      await this.options.persistence.markInboundEventStatus(input.eventId, "skipped");
      return;
    }
    await this.handleSlackTurn({
      envelope: input as SlackInboundEventEnvelope & { event: SlackMessageImEvent },
      getSlackKey: (installation) => dmSlackKey(installation.teamId, input.event.user),
      getReplyThreadTs: () => undefined,
      getChannelContext: (installation) => ({
        provider: "slack",
        team: {
          id: installation.teamId,
          ...(installation.teamName ? { name: installation.teamName } : {}),
        },
        channel: { id: input.event.channel, type: "im" },
        user: { id: input.event.user },
      }),
    });
  }

  async handleAppMention(input: SlackInboundEventEnvelope & { event: SlackAppMentionEvent }): Promise<void> {
    await this.handleSlackTurn({
      envelope: input,
      getSlackKey: (installation) => {
        const threadTs = input.event.thread_ts ?? input.event.ts;
        return mentionSlackKey(installation.teamId, input.event.channel, threadTs);
      },
      getReplyThreadTs: () => input.event.thread_ts ?? input.event.ts,
      getChannelContext: (installation) => ({
        provider: "slack",
        team: {
          id: installation.teamId,
          ...(installation.teamName ? { name: installation.teamName } : {}),
        },
        channel: { id: input.event.channel, type: "channel" },
        threadTs: input.event.thread_ts ?? input.event.ts,
        user: { id: input.event.user },
      }),
    });
  }

  private async handleSlackTurn(input: {
    envelope: SlackInboundEventEnvelope & { event: SlackMessageImEvent | SlackAppMentionEvent };
    getSlackKey: (installation: SlackInstallationRecord) => string;
    getReplyThreadTs: () => string | undefined;
    getChannelContext: (installation: SlackInstallationRecord) => ConversationChannelContext;
  }): Promise<void> {
    const { envelope } = input;
    const installation = await this.options.installations.findByTeamId(envelope.teamId);
    if (!installation) {
      await this.options.persistence.markInboundEventStatus(envelope.eventId, "skipped");
      this.options.logger.info({ teamId: envelope.teamId, eventId: envelope.eventId }, "Slack inbound skipped without installation");
      return;
    }

    const binding = await this.options.bindings.findByInstallationId(installation.id);
    if (!binding?.answeringAgentId) {
      await this.options.persistence.markInboundEventStatus(envelope.eventId, "skipped");
      this.options.logger.info(
        { workspaceId: installation.workspaceId, installationId: installation.id, eventId: envelope.eventId },
        "Slack inbound skipped without answering agent binding",
      );
      return;
    }

    const query = envelope.event.text.trim();
    if (!query) {
      await this.options.persistence.markInboundEventStatus(envelope.eventId, "skipped");
      return;
    }

    const slackKey = input.getSlackKey(installation);
    const existingLink = await this.options.persistence.findConversationLink({
      workspaceId: installation.workspaceId,
      slackKey,
    });

    this.options.logger.info(
      { workspaceId: installation.workspaceId, installationId: installation.id, eventId: envelope.eventId },
      "Slack turn dispatch started",
    );
    const response = await this.options.chat.answer({
      workspaceId: installation.workspaceId,
      agentId: binding.answeringAgentId,
      conversationId: existingLink?.conversationId,
      query,
      sourceChannel: "slack",
      channelContext: input.getChannelContext(installation),
    });
    await this.options.persistence.upsertConversationLink({
      workspaceId: installation.workspaceId,
      installationId: installation.id,
      slackKey,
      conversationId: response.conversationId,
    });
    await this.enqueueGapEscalationIfNeeded({
      envelope,
      installation,
      escalationChannelId: binding.escalationChannelId,
      gapEscalationEnabled: binding.gapEscalationEnabled,
      query,
      conversationId: response.conversationId,
      outcome: response.outcome,
    });

    const botToken = await this.options.installationService.resolveBotTokenForInstallation(installation);
    if (!botToken) {
      await this.options.installationService.markNeedsReauthForInstallation(installation, "slack_bot_token_not_found");
      await this.options.persistence.markInboundEventStatus(envelope.eventId, "skipped");
      this.options.logger.warn(
        { workspaceId: installation.workspaceId, installationId: installation.id, eventId: envelope.eventId },
        "Slack reply skipped without bot token",
      );
      return;
    }

    try {
      await postSlackText(this.clientFactory({ botToken }), {
        channel: envelope.event.channel,
        text: response.answer,
        threadTs: input.getReplyThreadTs(),
      });
    } catch (error) {
      const authErrorCode = slackAuthErrorCode(error);
      if (authErrorCode) {
        await this.options.installationService.markNeedsReauthForInstallation(
          installation,
          authErrorCode,
        );
      }
      throw error;
    }
    await this.options.persistence.markInboundEventStatus(envelope.eventId, "processed");
    this.options.logger.info(
      { workspaceId: installation.workspaceId, installationId: installation.id, eventId: envelope.eventId },
      "Slack reply delivered",
    );
  }

  private async enqueueGapEscalationIfNeeded(input: {
    envelope: SlackInboundEventEnvelope;
    installation: SlackInstallationRecord;
    escalationChannelId: string | null;
    gapEscalationEnabled: boolean;
    query: string;
    conversationId: string;
    outcome: "answered" | "no_context";
  }): Promise<void> {
    if (
      input.outcome !== "no_context" ||
      !input.gapEscalationEnabled ||
      !input.escalationChannelId ||
      !this.options.slackPostOutbox
    ) {
      return;
    }
    const message = buildOwnershipMessage({
      conversationId: input.conversationId,
      workspaceId: input.installation.workspaceId,
      state: "ai_owned",
      contextText: input.query,
      dashboardPath: `/conversations/${input.conversationId}`,
    });
    await enqueueSlackPostAction(this.options.slackPostOutbox, {
      workspaceId: input.installation.workspaceId,
      conversationId: input.conversationId,
      idempotencyKey: slackPostIdempotencyKey({
        kind: "gap_escalation",
        sourceId: `${input.envelope.eventId}:${input.conversationId}`,
      }),
      payload: {
        installationId: input.installation.id,
        channelId: input.escalationChannelId,
        text: message.text,
        blocks: message.blocks,
        conversationRef: input.conversationId,
        kind: "gap_escalation",
      },
    });
    this.options.logger.info(
      {
        workspaceId: input.installation.workspaceId,
        installationId: input.installation.id,
        eventId: input.envelope.eventId,
        conversationId: input.conversationId,
      },
      "Slack gap escalation enqueued",
    );
  }

  isBotLoop(installation: SlackInstallationRecord | null, event: { user?: unknown; bot_id?: unknown }): boolean {
    if (typeof event.bot_id === "string" && event.bot_id.length > 0) {
      return true;
    }
    return Boolean(installation?.botUserId && event.user === installation.botUserId);
  }
}
