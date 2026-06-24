import { createHash } from "node:crypto";

import {
  enqueueSlackPostAction,
  slackPostIdempotencyKey,
  type SlackPostOutboxPort,
} from "../outbox/slackPostAction.js";
import type {
  SlackInstallationRepositoryPort,
  SlackInstallationService,
} from "../install/slackInstallationService.js";
import type {
  CustomerChannelReplyDeliverer,
  CustomerReplyDeliveryInput,
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
  channelId: string;
  threadTs?: string;
};

const replySourceId = (input: CustomerReplyDeliveryInput): string => {
  if (input.message.id) {
    return `${input.conversation.id}:${input.message.id}`;
  }
  const digest = createHash("sha256").update(input.message.content).digest("hex");
  return `${input.conversation.id}:content:${digest}`;
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

export class SlackCustomerReplyDeliverer implements CustomerChannelReplyDeliverer {
  constructor(private readonly dependencies: {
    // Resolve the installation that OWNS the conversation (by team / link id), never the
    // workspace's latest install — a workspace can reinstall or connect a different team, and a
    // reply sent with the wrong bot token could land in a same-ID channel in another Slack team.
    installations: Pick<SlackInstallationRepositoryPort, "findByTeamId" | "findById">;
    installationService?: Pick<SlackInstallationService, "resolveBotTokenForInstallation">;
    persistence?: SlackConversationLinkLookupPort;
    slack?: SlackConversationOpenPort;
    outbox: SlackPostOutboxPort;
    logger?: SlackReplyDelivererLogger;
  }) {}

  async deliver(input: CustomerReplyDeliveryInput): Promise<void> {
    if (input.conversation.sourceChannel !== "slack") {
      return;
    }

    const target = await this.resolveReplyTarget(input);
    if (!target) {
      this.dependencies.logger?.warn(
        {
          workspaceId: input.conversation.workspaceId,
          conversationId: input.conversation.id,
        },
        "Unable to resolve Slack customer reply target",
      );
      return;
    }

    await enqueueSlackPostAction(this.dependencies.outbox, {
      workspaceId: input.conversation.workspaceId,
      conversationId: input.conversation.id,
      idempotencyKey: slackPostIdempotencyKey({
        kind: "human_reply",
        sourceId: replySourceId(input),
      }),
      payload: {
        installationId: target.installationId,
        channelId: target.channelId,
        text: input.message.content,
        ...(target.threadTs ? { threadTs: target.threadTs } : {}),
        conversationRef: input.conversation.id,
        kind: "human_reply",
      },
    });
  }

  private async resolveReplyTarget(input: CustomerReplyDeliveryInput): Promise<SlackReplyTarget | null> {
    const channelContext = input.conversation.channelContext;
    if (channelContext?.provider === "slack") {
      // Resolve by the conversation's team (one installation per team_id), not the workspace.
      const installation = await this.dependencies.installations.findByTeamId(channelContext.team.id);
      if (!installation) {
        return null;
      }
      return {
        installationId: installation.id,
        channelId: channelContext.channel.id,
        ...(channelContext.threadTs ? { threadTs: channelContext.threadTs } : {}),
      };
    }

    const link = await this.dependencies.persistence?.findConversationLinkByConversationId({
      workspaceId: input.conversation.workspaceId,
      conversationId: input.conversation.id,
    });
    if (!link) {
      return null;
    }

    const legacyTarget = parseLegacySlackKey(link.slackKey);
    if (!legacyTarget) {
      return null;
    }

    if (legacyTarget.kind === "mention") {
      return {
        installationId: link.installationId,
        channelId: legacyTarget.channelId,
        threadTs: legacyTarget.threadTs,
      };
    }

    // The legacy link records the exact installation that created the conversation; use it
    // directly (not the workspace's latest) so the DM opens with the correct team's bot token.
    const installation = await this.dependencies.installations.findById(link.installationId);
    const botToken = installation
      ? await this.dependencies.installationService?.resolveBotTokenForInstallation(installation)
      : null;
    if (!botToken || !this.dependencies.slack) {
      return null;
    }
    const opened = await this.dependencies.slack.conversationsOpen({
      users: legacyTarget.userId,
      botToken,
    });
    return {
      installationId: link.installationId,
      channelId: opened.channelId,
    };
  }
}
