import { describe, expect, it, vi } from "vitest";
import type { ConversationChannelContext } from "@radioso/conversation-contract";

import {
  CustomerReplyDeliveryDispatcher,
  type CustomerChannelReplyDeliverer,
} from "../../src/modules/customerReplyDelivery/public.js";
import { SlackCustomerReplyDeliverer } from "../../src/modules/slack/public.js";

const slackContext: ConversationChannelContext = {
  provider: "slack",
  team: { id: "T1", name: "Acme" },
  channel: { id: "D1", type: "im" },
  threadTs: "1700000000.000100",
  user: { id: "U1" },
};

describe("CustomerReplyDeliveryDispatcher", () => {
  it("routes Slack-origin conversations to the registered Slack deliverer", async () => {
    const slackDeliverer: CustomerChannelReplyDeliverer = { deliver: vi.fn() };
    const dispatcher = new CustomerReplyDeliveryDispatcher({ slack: slackDeliverer });
    const input = {
      conversation: {
        id: "conversation-1",
        workspaceId: "workspace-1",
        sourceChannel: "slack",
        channelContext: slackContext,
      },
      message: { content: "Human reply" },
    };

    await dispatcher.deliver(input);

    expect(slackDeliverer.deliver).toHaveBeenCalledWith(input);
  });

  it("falls back to sourceChannel for older Slack conversations and no-ops for web", async () => {
    const slackDeliverer: CustomerChannelReplyDeliverer = { deliver: vi.fn() };
    const dispatcher = new CustomerReplyDeliveryDispatcher({ slack: slackDeliverer });

    await dispatcher.deliver({
      conversation: {
        id: "legacy-slack",
        workspaceId: "workspace-1",
        sourceChannel: "slack",
        channelContext: null,
      },
      message: { content: "Human reply" },
    });
    await dispatcher.deliver({
      conversation: {
        id: "web-conversation",
        workspaceId: "workspace-1",
        sourceChannel: "authenticated_chat",
        channelContext: { provider: "web", origin: "authenticated_chat" },
      },
      message: { content: "Human reply" },
    });

    expect(slackDeliverer.deliver).toHaveBeenCalledTimes(1);
  });
});

describe("SlackCustomerReplyDeliverer", () => {
  const installation = {
    id: "11111111-1111-1111-1111-111111111111",
    connectionId: "connection-1",
    workspaceId: "workspace-1",
    accountId: "account-1",
    teamId: "T1",
    teamName: "Acme",
    botUserId: "UBOT",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it("enqueues a human_reply slack.post to the customer channel and thread", async () => {
    const outbox = { enqueue: vi.fn(async () => ({ id: "action-1", duplicate: false })) };
    const deliverer = new SlackCustomerReplyDeliverer({
      installations: {
        findByTeamId: vi.fn(async () => installation),
        findById: vi.fn(async () => installation),
      },
      outbox,
    });

    await deliverer.deliver({
      conversation: {
        id: "conversation-1",
        workspaceId: "workspace-1",
        sourceChannel: "slack",
        channelContext: slackContext,
      },
      message: { id: "message-1", content: "Human reply" },
    });

    expect(outbox.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      type: "slack.post",
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      idempotencyKey: "slack:human_reply:conversation-1:message-1",
      payload: expect.objectContaining({
        installationId: "11111111-1111-1111-1111-111111111111",
        channelId: "D1",
        threadTs: "1700000000.000100",
        conversationRef: "conversation-1",
        kind: "human_reply",
        text: "Human reply",
      }),
    }));
  });

  it("enqueues a legacy mention reply using the conversation link channel and thread", async () => {
    const outbox = { enqueue: vi.fn(async () => ({ id: "action-1", duplicate: false })) };
    const deliverer = new SlackCustomerReplyDeliverer({
      installations: { findByTeamId: vi.fn(async () => installation), findById: vi.fn(async () => installation) },
      persistence: {
        findConversationLinkByConversationId: vi.fn(async () => ({
          slackKey: "mention:T1:CMENTION:1700000000.000200",
          installationId: installation.id,
        })),
      },
      outbox,
    });

    await deliverer.deliver({
      conversation: {
        id: "conversation-1",
        workspaceId: "workspace-1",
        sourceChannel: "slack",
        channelContext: null,
      },
      message: { id: "message-1", content: "Human reply" },
    });

    expect(outbox.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        installationId: installation.id,
        channelId: "CMENTION",
        threadTs: "1700000000.000200",
        kind: "human_reply",
        text: "Human reply",
      }),
    }));
  });

  it("opens a legacy DM channel before enqueueing the reply", async () => {
    const outbox = { enqueue: vi.fn(async () => ({ id: "action-1", duplicate: false })) };
    const conversationsOpen = vi.fn(async () => ({ channelId: "DOPENED" }));
    const deliverer = new SlackCustomerReplyDeliverer({
      installations: {
        findByTeamId: vi.fn(async () => installation),
        findById: vi.fn(async () => installation),
      },
      installationService: {
        resolveBotTokenForInstallation: vi.fn(async () => "xoxb-token"),
      },
      slack: { conversationsOpen },
      persistence: {
        findConversationLinkByConversationId: vi.fn(async () => ({
          slackKey: "dm:T1:UUSER",
          installationId: installation.id,
        })),
      },
      outbox,
    });

    await deliverer.deliver({
      conversation: {
        id: "conversation-1",
        workspaceId: "workspace-1",
        sourceChannel: "slack",
        channelContext: null,
      },
      message: { id: "message-1", content: "Human reply" },
    });

    expect(conversationsOpen).toHaveBeenCalledWith({ users: "UUSER", botToken: "xoxb-token" });
    expect(outbox.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        installationId: installation.id,
        channelId: "DOPENED",
        kind: "human_reply",
        text: "Human reply",
      }),
    }));
  });

  it("warns and no-ops when a legacy Slack conversation has no resolvable link", async () => {
    const outbox = { enqueue: vi.fn(async () => ({ id: "action-1", duplicate: false })) };
    const logger = { warn: vi.fn() };
    const deliverer = new SlackCustomerReplyDeliverer({
      installations: { findByTeamId: vi.fn(async () => installation), findById: vi.fn(async () => installation) },
      persistence: {
        findConversationLinkByConversationId: vi.fn(async () => null),
      },
      outbox,
      logger,
    });

    await deliverer.deliver({
      conversation: {
        id: "conversation-1",
        workspaceId: "workspace-1",
        sourceChannel: "slack",
        channelContext: null,
      },
      message: { id: "message-1", content: "Human reply" },
    });

    expect(outbox.enqueue).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "conversation-1", workspaceId: "workspace-1" }),
      expect.any(String),
    );
  });
});
