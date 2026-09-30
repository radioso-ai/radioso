import {
  enqueueSlackPostAction,
  slackPostIdempotencyKey,
} from "../outbox/slackPostAction.js";
import type {
  SlackInstallationRepositoryPort,
  SlackInstallationService,
} from "../install/slackInstallationService.js";
import type {
  CustomerChannelReplyDeliverer,
  CustomerReplyDeliveryConversation,
  CustomerReplyRoute,
} from "../../customerReplyDelivery/public.js";
import type { SlackConversationLinkLookupPort } from "./slackConversationLinkLookup.js";

interface SlackConversationOpenPort {
  conversationsOpen(input: { users: string; botToken: string }): Promise<{ channelId: string }>;
}

interface SlackReplyDelivererLogger {
  warn(payload: Record<string, unknown>, message: string): void;
}

type SlackReplyTarget = {
  installationId: string;
  accountId: string;
  channelId: string;
  threadTs?: string;
};

const parseLegacySlackKey = (slackKey: string):
  | { kind: "mention"; channelId: string; threadTs: string }
  | { kind: "dm"; userId: string }
  | null => {
  const parts = slackKey.split(":");
  const [kind, teamId, third, fourth] = parts;
  if (kind === "mention" && parts.length === 4 && teamId && third && fourth) {
    return { kind, channelId: third, threadTs: fourth };
  }
  if (kind === "dm" && parts.length === 3 && teamId && third) {
    return { kind, userId: third };
  }
  return null;
};

/**
 * Routes a teammate's reply to the Slack channel and thread its conversation came from. The route
 * is resolved before the reply's transaction — a legacy DM link opens the DM with Slack's API — and
 * queues a `slack.post` on the outbox the caller hands it, keyed by the message so a reply posts once.
 */
export class SlackCustomerReplyDeliverer implements CustomerChannelReplyDeliverer {
  constructor(private readonly dependencies: {
    // Resolve the installation that OWNS the conversation (by team / link id), never the
    // workspace's latest install — a workspace can reinstall or connect a different team, and a
    // reply sent with the wrong bot token could land in a same-ID channel in another Slack team.
    installations: Pick<SlackInstallationRepositoryPort, "findByTeamId" | "findById">;
    installationService?: Pick<SlackInstallationService, "resolveBotTokenForInstallation">;
    persistence?: SlackConversationLinkLookupPort;
    slack?: SlackConversationOpenPort;
    logger?: SlackReplyDelivererLogger;
  }) {}

  async route(conversation: CustomerReplyDeliveryConversation): Promise<CustomerReplyRoute | null> {
    if (conversation.sourceChannel !== "slack") {
      return null;
    }

    const target = await this.resolveReplyTarget(conversation);
    if (!target) {
      this.dependencies.logger?.warn(
        {
          workspaceId: conversation.workspaceId,
          conversationId: conversation.id,
        },
        "Unable to resolve Slack customer reply target",
      );
      return null;
    }

    return {
      enqueue: async (outbox, message) => {
        await enqueueSlackPostAction(outbox, {
          workspaceId: conversation.workspaceId,
          accountId: target.accountId,
          conversationId: conversation.id,
          idempotencyKey: slackPostIdempotencyKey({
            kind: "human_reply",
            sourceId: `${conversation.id}:${message.id}`,
          }),
          payload: {
            installationId: target.installationId,
            channelId: target.channelId,
            text: message.content,
            ...(target.threadTs ? { threadTs: target.threadTs } : {}),
            conversationRef: conversation.id,
            kind: "human_reply",
          },
        });
      },
    };
  }

  private async resolveReplyTarget(conversation: CustomerReplyDeliveryConversation): Promise<SlackReplyTarget | null> {
    const channelContext = conversation.channelContext;
    if (channelContext?.provider === "slack") {
      // Resolve by the conversation's team (one installation per team_id), not the workspace.
      const installation = await this.dependencies.installations.findByTeamId(channelContext.team.id);
      if (!installation) {
        return null;
      }
      return {
        installationId: installation.id,
        accountId: installation.accountId,
        channelId: channelContext.channel.id,
        ...(channelContext.threadTs ? { threadTs: channelContext.threadTs } : {}),
      };
    }

    const link = await this.dependencies.persistence?.findConversationLinkByConversationId({
      workspaceId: conversation.workspaceId,
      conversationId: conversation.id,
    });
    if (!link) {
      return null;
    }

    const legacyTarget = parseLegacySlackKey(link.slackKey);
    if (!legacyTarget) {
      return null;
    }

    if (legacyTarget.kind === "mention") {
      const installation = await this.dependencies.installations.findById(link.installationId);
      if (!installation) {
        return null;
      }
      return {
        installationId: link.installationId,
        accountId: installation.accountId,
        channelId: legacyTarget.channelId,
        threadTs: legacyTarget.threadTs,
      };
    }

    // The legacy link records the exact installation that created the conversation; use it
    // directly (not the workspace's latest) so the DM opens with the correct team's bot token.
    const installation = await this.dependencies.installations.findById(link.installationId);
    if (!installation) {
      return null;
    }
    const botToken = await this.dependencies.installationService?.resolveBotTokenForInstallation(installation);
    if (!botToken || !this.dependencies.slack) {
      return null;
    }
    const opened = await this.dependencies.slack.conversationsOpen({
      users: legacyTarget.userId,
      botToken,
    });
    return {
      installationId: link.installationId,
      accountId: installation.accountId,
      channelId: opened.channelId,
    };
  }
}
