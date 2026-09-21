import type {
  ConnectorChatOutcome,
  ConnectorChatPort,
  ConnectorLogger,
} from "@radioso/connector-api";
import type { ConversationChannelContext } from "@radioso/conversation-contract";

import {
  SlackWebApiClient,
  describeSlackError,
  postSlackMarkdown,
  slackAuthErrorCode,
  type SlackWebApiClientOptions,
  type SlackWebApiClient as SlackWebApiClientInstance,
  type SlackBindingRepositoryPort,
  type SlackChannelBindingRecord,
  type SlackInstallationRecord,
  type SlackInstallationRepositoryPort,
  type SlackInstallationService,
  enqueueSlackPostAction,
  slackPostIdempotencyKey,
  type SlackPostOutboxPort,
  buildOwnershipMessage,
} from "../../../slack/public.js";
import { toSuggestedPrompts, type SlackStarterPromptsPort } from "./slackAgentSession.js";
import {
  resolveChannelMessageDisposition,
  type SlackChannelMessageSkipReason,
} from "./slackChannelMessageDisposition.js";
import type { SlackPersistencePort } from "./slackPersistence.js";
import { createSlackTurnSurface, type SlackTurnOutcome, type SlackTurnSurfaceRef } from "./slackTurnSurface.js";
import type { WorkspaceInvalidationPublisher } from "@radioso/workspace-invalidation-contract";

// A direct message to the app. In Slack's agent pane every session is a thread in the
// app DM, so a `thread_ts` marks a session message; without it this is a plain DM.
export interface SlackMessageImEvent {
  type: "message";
  channel_type: "im";
  channel: string;
  user: string;
  text: string;
  ts: string;
  thread_ts?: string;
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

// An un-mentioned message in a public (`channel`) or private (`group`) channel.
export interface SlackChannelMessageEvent {
  type: "message";
  channel_type: "channel" | "group";
  channel: string;
  user: string;
  text: string;
  ts: string;
  thread_ts?: string;
  bot_id?: string;
}

// A user opened the app's Home; the Messages tab is where suggested prompts live.
export interface SlackAppHomeOpenedEvent {
  type: "app_home_opened";
  user: string;
  channel: string;
  tab: "messages" | "home";
}

type SlackInboundMessageEvent = SlackMessageImEvent | SlackAppMentionEvent | SlackChannelMessageEvent;
export type SlackInboundEvent = SlackInboundMessageEvent | SlackAppHomeOpenedEvent;

export interface SlackInboundEventEnvelope<Event extends SlackInboundEvent = SlackInboundEvent> {
  eventId: string;
  teamId: string;
  event: Event;
}

export type SlackWebApiClientFactory = (
  options: Pick<SlackWebApiClientOptions, "botToken">,
) => Pick<
  SlackWebApiClientInstance,
  "postMessage" | "addReaction" | "removeReaction" | "setAgentSessionStatus" | "renameAgentSession" | "setSuggestedPrompts"
>;

const readSupersededTurn = (error: unknown): { conversationId?: string; stage?: string } | null => {
  if (!error || typeof error !== "object" || !("code" in error) || error.code !== "chat_turn_superseded") {
    return null;
  }
  const details = "details" in error && error.details && typeof error.details === "object"
    ? error.details as Record<string, unknown>
    : null;
  const conversationId = "conversationId" in error && typeof error.conversationId === "string"
    ? error.conversationId
    : typeof details?.conversationId === "string"
      ? details.conversationId
      : undefined;
  const stage = "stage" in error && typeof error.stage === "string"
    ? error.stage
    : typeof details?.stage === "string"
      ? details.stage
      : undefined;
  return { conversationId, stage };
};

interface SlackMessageHandlerOptions {
  logger: ConnectorLogger;
  chat: ConnectorChatPort;
  installations: SlackInstallationRepositoryPort;
  bindings: Pick<SlackBindingRepositoryPort, "findAnswerer">;
  installationService: Pick<SlackInstallationService, "markNeedsReauthForInstallation" | "resolveBotTokenForInstallation">;
  persistence: SlackPersistencePort;
  slackPostOutbox?: SlackPostOutboxPort;
  clientFactory?: SlackWebApiClientFactory;
  workspaceInvalidationPublisher?: WorkspaceInvalidationPublisher;
  /** Absent when no starter source is wired; the agent pane then shows no prompts. */
  starterPrompts?: SlackStarterPromptsPort;
}

const dmSlackKey = (teamId: string, userId: string): string => `dm:${teamId}:${userId}`;
// One conversation per channel thread. The `mention:` prefix is historical — it predates
// un-mentioned thread follow-ups — and stays because persisted links and
// slackCustomerReplyDeliverer parse it.
const threadSlackKey = (teamId: string, channelId: string, threadTs: string): string =>
  `mention:${teamId}:${channelId}:${threadTs}`;

// Slack renders a user mention as `<@U123>` or, in older payloads, `<@U123|handle>`.
const mentionsUser = (text: string, userId: string): boolean =>
  text.includes(`<@${userId}>`) || text.includes(`<@${userId}|`);

const channelThreadContext = (
  installation: SlackInstallationRecord,
  event: { channel: string; user: string },
  threadTs: string,
): ConversationChannelContext => ({
  provider: "slack",
  team: {
    id: installation.teamId,
    ...(installation.teamName ? { name: installation.teamName } : {}),
  },
  channel: { id: event.channel, type: "channel" },
  threadTs,
  user: { id: event.user },
});

interface ResolvedSlackRouting {
  installation: SlackInstallationRecord;
  binding: SlackChannelBindingRecord;
}

// "bot_mentioned" is decided before the binding lookup: Slack also emits app_mention for it.
type ChannelMessageSkipReason = SlackChannelMessageSkipReason | "bot_mentioned";

export class SlackMessageHandler {
  private readonly clientFactory: SlackWebApiClientFactory;

  constructor(private readonly options: SlackMessageHandlerOptions) {
    this.clientFactory = options.clientFactory ?? ((clientOptions) => new SlackWebApiClient(clientOptions));
  }

  async handleMessageIm(input: SlackInboundEventEnvelope<SlackMessageImEvent>): Promise<void> {
    const { event } = input;
    const installation = await this.resolveInstallation(input);
    if (!installation) {
      return;
    }
    // DMs have no routable channel; resolve straight to the installation default answerer.
    const binding = await this.resolveBinding(input, installation, null);
    if (!binding) {
      return;
    }
    const team = {
      id: installation.teamId,
      ...(installation.teamName ? { name: installation.teamName } : {}),
    };
    if (event.thread_ts) {
      // An agent-pane session: one conversation per thread, keyed like a channel thread so
      // operator replies (slackCustomerReplyDeliverer) land in the session unchanged.
      await this.handleSlackTurn({
        envelope: input,
        installation,
        binding,
        surface: { kind: "dm_session", threadTs: event.thread_ts },
        slackKey: threadSlackKey(installation.teamId, event.channel, event.thread_ts),
        replyThreadTs: event.thread_ts,
        channelContext: {
          provider: "slack",
          team,
          channel: { id: event.channel, type: "im" },
          threadTs: event.thread_ts,
          user: { id: event.user },
        },
      });
      return;
    }
    await this.handleSlackTurn({
      envelope: input,
      installation,
      binding,
      surface: { kind: "dm" },
      slackKey: dmSlackKey(installation.teamId, event.user),
      replyThreadTs: undefined,
      channelContext: {
        provider: "slack",
        team,
        channel: { id: event.channel, type: "im" },
        user: { id: event.user },
      },
    });
  }

  /**
   * The Messages tab of the app Home is the agent pane's landing view; its suggested
   * prompts are the default agent's greeting chips. Nothing is started here.
   */
  async handleAppHomeOpened(input: SlackInboundEventEnvelope<SlackAppHomeOpenedEvent>): Promise<void> {
    const { event } = input;
    if (event.tab !== "messages" || !this.options.starterPrompts) {
      await this.options.persistence.markInboundEventStatus(input.eventId, "skipped");
      return;
    }
    const installation = await this.resolveInstallation(input);
    if (!installation) {
      return;
    }
    const binding = await this.resolveBinding(input, installation, null);
    if (!binding) {
      return;
    }
    const logContext = { workspaceId: binding.workspaceId, installationId: installation.id, eventId: input.eventId };
    let prompts: ReturnType<typeof toSuggestedPrompts>;
    try {
      prompts = toSuggestedPrompts(await this.options.starterPrompts.listStarterPrompts({
        workspaceId: binding.workspaceId,
        agentId: binding.answeringAgentId,
      }));
    } catch (error) {
      // A Home open is not worth a retry: the bound agent being gone (or any other read failure)
      // would otherwise re-run on every visit to the Messages tab.
      this.options.logger.warn(
        { ...logContext, errorType: error instanceof Error ? error.name : typeof error },
        "Slack suggested prompts could not be read",
      );
      await this.options.persistence.markInboundEventStatus(input.eventId, "failed");
      return;
    }
    if (prompts.length === 0) {
      await this.options.persistence.markInboundEventStatus(input.eventId, "skipped");
      return;
    }
    const botToken = await this.options.installationService.resolveBotTokenForInstallation(installation);
    if (!botToken) {
      await this.options.installationService.markNeedsReauthForInstallation(installation, "slack_bot_token_not_found");
      await this.options.persistence.markInboundEventStatus(input.eventId, "skipped");
      return;
    }
    try {
      await this.clientFactory({ botToken }).setSuggestedPrompts({ channelId: event.channel, prompts });
    } catch (error) {
      // Never rethrown: a Home open must not retry-storm, and `missing_scope` is the expected
      // outcome for an install that predates assistant:write. A revoked or invalid token is
      // still the install's problem, so it flips the connection to needs_reauth like a turn would.
      const authErrorCode = slackAuthErrorCode(error);
      if (authErrorCode) {
        await this.options.installationService.markNeedsReauthForInstallation(installation, authErrorCode);
      }
      this.options.logger.warn(
        { ...logContext, promptCount: prompts.length, ...describeSlackError(error) },
        "Slack suggested prompts update failed",
      );
      await this.options.persistence.markInboundEventStatus(input.eventId, "failed");
      return;
    }
    await this.options.persistence.markInboundEventStatus(input.eventId, "processed");
    this.options.logger.info({ ...logContext, promptCount: prompts.length }, "Slack suggested prompts set");
  }

  async handleAppMention(input: SlackInboundEventEnvelope & { event: SlackAppMentionEvent }): Promise<void> {
    const { event } = input;
    const installation = await this.resolveInstallation(input);
    if (!installation) {
      return;
    }
    // Channel mentions route by the originating channel; falls back to the default answerer.
    const binding = await this.resolveBinding(input, installation, event.channel);
    if (!binding) {
      return;
    }
    const threadTs = event.thread_ts ?? event.ts;
    await this.handleSlackTurn({
      envelope: input,
      installation,
      binding,
      surface: { kind: "channel" },
      slackKey: threadSlackKey(installation.teamId, event.channel, threadTs),
      replyThreadTs: threadTs,
      channelContext: channelThreadContext(installation, event, threadTs),
    });
  }

  /**
   * An un-mentioned channel message: answered when it continues a thread Radioso already
   * owns, or when the channel's explicit binding answers every message.
   */
  async handleChannelMessage(input: SlackInboundEventEnvelope & { event: SlackChannelMessageEvent }): Promise<void> {
    const { event } = input;
    const installation = await this.resolveInstallation(input);
    if (!installation) {
      return;
    }
    // Slack emits both app_mention and message.* for a mention; the app_mention path owns it.
    if (mentionsUser(event.text, installation.botUserId)) {
      await this.skipChannelMessage(input, installation, "bot_mentioned");
      return;
    }
    const binding = await this.resolveBinding(input, installation, event.channel);
    if (!binding) {
      return;
    }
    const hasOwnedThread = event.thread_ts !== undefined
      && (await this.options.persistence.findConversationLink({
        workspaceId: binding.workspaceId,
        slackKey: threadSlackKey(installation.teamId, event.channel, event.thread_ts),
      })) !== null;
    const disposition = resolveChannelMessageDisposition({
      ts: event.ts,
      threadTs: event.thread_ts,
      hasOwnedThread,
      binding: { channelId: binding.channelId, respondMode: binding.respondMode },
    });
    if (disposition.kind === "skip") {
      await this.skipChannelMessage(input, installation, disposition.reason, binding);
      return;
    }
    await this.handleSlackTurn({
      envelope: input,
      installation,
      binding,
      surface: { kind: "channel" },
      slackKey: threadSlackKey(installation.teamId, event.channel, disposition.threadTs),
      replyThreadTs: disposition.threadTs,
      channelContext: channelThreadContext(installation, event, disposition.threadTs),
    });
  }

  private async skipChannelMessage(
    envelope: SlackInboundEventEnvelope,
    installation: SlackInstallationRecord,
    reason: ChannelMessageSkipReason,
    binding?: SlackChannelBindingRecord,
  ): Promise<void> {
    await this.options.persistence.markInboundEventStatus(envelope.eventId, "skipped");
    // With channels:history every top-level post in every joined channel arrives here; the
    // mention-only skip is the expected fate of almost all of it and is not worth a line each.
    if (reason === "mention_only") {
      return;
    }
    this.options.logger.info(
      {
        workspaceId: binding?.workspaceId ?? installation.workspaceId,
        installationId: installation.id,
        eventId: envelope.eventId,
        reason,
        ...(binding ? { respondMode: binding.respondMode, boundChannel: binding.channelId !== null } : {}),
      },
      "Slack inbound skipped by channel respond policy",
    );
  }

  private async resolveInstallation(envelope: SlackInboundEventEnvelope): Promise<SlackInstallationRecord | null> {
    const installation = await this.options.installations.findByTeamId(envelope.teamId);
    if (!installation) {
      await this.options.persistence.markInboundEventStatus(envelope.eventId, "skipped");
      this.options.logger.info({ teamId: envelope.teamId, eventId: envelope.eventId }, "Slack inbound skipped without installation");
      return null;
    }
    return installation;
  }

  private async resolveBinding(
    envelope: SlackInboundEventEnvelope,
    installation: SlackInstallationRecord,
    routingChannelId: string | null,
  ): Promise<SlackChannelBindingRecord | null> {
    const binding = await this.options.bindings.findAnswerer(installation.id, routingChannelId);
    if (!binding?.answeringAgentId) {
      await this.options.persistence.markInboundEventStatus(envelope.eventId, "skipped");
      this.options.logger.info(
        { workspaceId: installation.workspaceId, installationId: installation.id, eventId: envelope.eventId },
        "Slack inbound skipped without answering agent binding",
      );
      return null;
    }
    return binding;
  }

  private async handleSlackTurn(input: ResolvedSlackRouting & {
    envelope: SlackInboundEventEnvelope<SlackInboundMessageEvent>;
    surface: SlackTurnSurfaceRef;
    slackKey: string;
    replyThreadTs: string | undefined;
    channelContext: ConversationChannelContext;
  }): Promise<void> {
    const { envelope, installation, binding, slackKey, channelContext } = input;
    const logContext = {
      workspaceId: binding.workspaceId,
      installationWorkspaceId: installation.workspaceId,
      installationId: installation.id,
      eventId: envelope.eventId,
      surface: input.surface.kind,
    };

    const query = envelope.event.text.trim();
    if (!query) {
      await this.options.persistence.markInboundEventStatus(envelope.eventId, "skipped");
      return;
    }

    // Resolve the bot token up front so we can acknowledge the message before generating an
    // answer and never burn an answer we cannot deliver.
    const botToken = await this.options.installationService.resolveBotTokenForInstallation(installation);
    if (!botToken) {
      await this.options.installationService.markNeedsReauthForInstallation(installation, "slack_bot_token_not_found");
      await this.options.persistence.markInboundEventStatus(envelope.eventId, "skipped");
      this.options.logger.warn(logContext, "Slack reply skipped without bot token");
      return;
    }
    const client = this.clientFactory({ botToken });
    // Claim the thread's conversation before any Slack round-trip: an un-mentioned follow-up
    // that lands while this turn is still signalling work must already find the link.
    const conversationLinkOutcome = await this.options.persistence.getOrCreateConversationLink({
      workspaceId: binding.workspaceId,
      installationId: installation.id,
      slackKey,
      agentId: binding.answeringAgentId,
      sourceChannel: "slack",
      channelContext,
    });
    const conversationLink = conversationLinkOutcome.link;
    if (conversationLinkOutcome.created) {
      this.options.workspaceInvalidationPublisher?.enqueue(binding.workspaceId, ["conversation.created"]);
    }

    const surface = createSlackTurnSurface({
      surface: input.surface,
      client,
      logger: this.options.logger,
      channel: envelope.event.channel,
      ts: envelope.event.ts,
      logContext: { workspaceId: binding.workspaceId, installationId: installation.id, eventId: envelope.eventId },
    });
    await surface.begin();
    let settled = false;
    const settle = async (outcome: SlackTurnOutcome): Promise<void> => {
      settled = true;
      await surface.settle(outcome);
    };

    try {
      this.options.logger.info(logContext, "Slack turn dispatch started");
      let response: Awaited<ReturnType<ConnectorChatPort["answer"]>>;
      try {
        response = await this.options.chat.answer({
          workspaceId: binding.workspaceId,
          agentId: binding.answeringAgentId,
          conversationId: conversationLink.conversationId,
          query,
          sourceChannel: "slack",
          channelContext,
        });
      } catch (error) {
        const superseded = readSupersededTurn(error);
        if (!superseded) {
          throw error;
        }
        await settle("superseded");
        const supersededContext = {
          ...logContext,
          conversationId: superseded.conversationId ?? conversationLink.conversationId,
          stage: superseded.stage,
        };
        try {
          await this.options.persistence.markInboundEventStatus(envelope.eventId, "skipped");
        } catch (statusError) {
          this.options.logger.warn(
            { ...supersededContext, errorType: statusError instanceof Error ? statusError.name : typeof statusError },
            "Slack superseded status update failed",
          );
        }
        this.options.logger.info(supersededContext, "Slack turn superseded");
        return;
      }
      await this.enqueueGapEscalationIfNeeded({
        envelope,
        installation,
        workspaceId: binding.workspaceId,
        escalationChannelId: binding.escalationChannelId,
        gapEscalationEnabled: binding.gapEscalationEnabled,
        query,
        conversationId: response.conversationId,
        outcome: response.outcome,
      });

      // A turn can complete with nothing to say — a conversation a person has taken over
      // answers this way — and Slack rejects an empty post, so there is nothing to deliver.
      if (response.answer.trim() === "") {
        await settle("silent");
        await this.options.persistence.markInboundEventStatus(envelope.eventId, "processed");
        this.options.logger.info(
          { ...logContext, conversationId: response.conversationId, reason: "empty_answer" },
          "Slack turn produced no reply",
        );
        return;
      }

      try {
        await postSlackMarkdown(client, {
          channel: envelope.event.channel,
          markdownText: response.answer,
          threadTs: input.replyThreadTs,
        });
      } catch (error) {
        await settle("failed");
        const authErrorCode = slackAuthErrorCode(error);
        if (authErrorCode) {
          await this.options.installationService.markNeedsReauthForInstallation(installation, authErrorCode);
        }
        throw error;
      }
      await settle("answered");
      if (conversationLinkOutcome.created) {
        await surface.nameConversation(query);
      }
      await this.options.persistence.markInboundEventStatus(envelope.eventId, "processed");
      this.options.logger.info(logContext, "Slack reply delivered");
    } finally {
      if (!settled) {
        await surface.abandon();
      }
    }
  }

  private async enqueueGapEscalationIfNeeded(input: {
    envelope: SlackInboundEventEnvelope;
    installation: SlackInstallationRecord;
    workspaceId: string;
    escalationChannelId: string | null;
    gapEscalationEnabled: boolean;
    query: string;
    conversationId: string;
    outcome: ConnectorChatOutcome;
  }): Promise<void> {
    // Only a real content gap escalates. Out-of-scope declines are correct behavior,
    // while unavailable generation is an operational failure that ingestion cannot fix.
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
      workspaceId: input.workspaceId,
      state: "ai_owned",
      contextText: input.query,
      dashboardPath: `/conversations/${input.conversationId}`,
    });
    await enqueueSlackPostAction(this.options.slackPostOutbox, {
      workspaceId: input.workspaceId,
      accountId: input.installation.accountId,
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
        workspaceId: input.workspaceId,
        installationWorkspaceId: input.installation.workspaceId,
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
