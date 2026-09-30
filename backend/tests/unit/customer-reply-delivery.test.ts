import { describe, expect, it, vi } from "vitest";
import type { ConversationChannelContext } from "@radioso/conversation-contract";

import {
  CustomerReplyDeliveryDispatcher,
  type CustomerChannelReplyDeliverer,
  type CustomerReplyRoute,
} from "../../src/modules/customerReplyDelivery/public.js";
import { SlackCustomerReplyDeliverer } from "../../src/modules/slack/public.js";

const slackContext: ConversationChannelContext = {
  provider: "slack",
  team: { id: "T1", name: "Acme" },
  channel: { id: "D1", type: "im" },
  threadTs: "1700000000.000100",
  user: { id: "U1" },
};

const slackConversation = {
  id: "conversation-1",
  workspaceId: "workspace-1",
  sourceChannel: "slack",
  channelContext: slackContext,
};

const legacySlackConversation = { ...slackConversation, channelContext: null };

const message = { id: "message-1", content: "Human reply" };

const fakeOutbox = () => ({ enqueue: vi.fn(async () => ({ id: "action-1", duplicate: false })) });

describe("CustomerReplyDeliveryDispatcher", () => {
  it("routes Slack-origin conversations to the registered Slack deliverer", async () => {
    const route: CustomerReplyRoute = { enqueue: vi.fn(async () => undefined) };
    const slackDeliverer: CustomerChannelReplyDeliverer = { route: vi.fn(async () => route) };
    const dispatcher = new CustomerReplyDeliveryDispatcher({ slack: slackDeliverer });

    await expect(dispatcher.route(slackConversation)).resolves.toBe(route);

    expect(slackDeliverer.route).toHaveBeenCalledWith(slackConversation);
  });

  it("falls back to sourceChannel for older Slack conversations and routes web nowhere", async () => {
    const slackDeliverer: CustomerChannelReplyDeliverer = { route: vi.fn(async () => null) };
    const dispatcher = new CustomerReplyDeliveryDispatcher({ slack: slackDeliverer });

    await dispatcher.route({ ...legacySlackConversation, id: "legacy-slack" });
    const web = await dispatcher.route({
      id: "web-conversation",
      workspaceId: "workspace-1",
      sourceChannel: "authenticated_chat",
      channelContext: { provider: "web", origin: "authenticated_chat" },
    });

    expect(slackDeliverer.route).toHaveBeenCalledTimes(1);
    expect(web).toBeNull();
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

  it("queues a human_reply slack.post to the customer channel and thread, on the outbox it is given, once per message", async () => {
    const outbox = fakeOutbox();
    const deliverer = new SlackCustomerReplyDeliverer({
      installations: {
        findByTeamId: vi.fn(async () => installation),
        findById: vi.fn(async () => installation),
      },
    });

    const route = await deliverer.route(slackConversation);
    await route?.enqueue(outbox, message);

    expect(outbox.enqueue).toHaveBeenCalledWith({
      type: "slack.post",
      workspaceId: "workspace-1",
      accountId: installation.accountId,
      conversationId: "conversation-1",
      idempotencyKey: "slack:human_reply:conversation-1:message-1",
      payload: {
        installationId: "11111111-1111-1111-1111-111111111111",
        channelId: "D1",
        threadTs: "1700000000.000100",
        conversationRef: "conversation-1",
        kind: "human_reply",
        text: "Human reply",
      },
    });
  });

  it("routes a legacy mention reply to the conversation link's channel and thread", async () => {
    const outbox = fakeOutbox();
    const deliverer = new SlackCustomerReplyDeliverer({
      installations: { findByTeamId: vi.fn(async () => installation), findById: vi.fn(async () => installation) },
      persistence: {
        findConversationLinkByConversationId: vi.fn(async () => ({
          slackKey: "mention:T1:CMENTION:1700000000.000200",
          installationId: installation.id,
        })),
      },
    });

    const route = await deliverer.route(legacySlackConversation);
    await route?.enqueue(outbox, message);

    expect(outbox.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      accountId: installation.accountId,
      payload: expect.objectContaining({
        installationId: installation.id,
        channelId: "CMENTION",
        threadTs: "1700000000.000200",
        kind: "human_reply",
        text: "Human reply",
      }),
    }));
  });

  it("opens a legacy DM channel while routing, before any reply is queued", async () => {
    const outbox = fakeOutbox();
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
    });

    const route = await deliverer.route(legacySlackConversation);

    expect(conversationsOpen).toHaveBeenCalledWith({ users: "UUSER", botToken: "xoxb-token" });
    expect(outbox.enqueue).not.toHaveBeenCalled();
    await route?.enqueue(outbox, message);
    expect(outbox.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      accountId: installation.accountId,
      payload: expect.objectContaining({
        installationId: installation.id,
        channelId: "DOPENED",
        kind: "human_reply",
        text: "Human reply",
      }),
    }));
  });

  it("warns and routes nowhere when a legacy Slack conversation has no resolvable link", async () => {
    const logger = { warn: vi.fn() };
    const deliverer = new SlackCustomerReplyDeliverer({
      installations: { findByTeamId: vi.fn(async () => installation), findById: vi.fn(async () => installation) },
      persistence: {
        findConversationLinkByConversationId: vi.fn(async () => null),
      },
      logger,
    });

    await expect(deliverer.route(legacySlackConversation)).resolves.toBeNull();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "conversation-1", workspaceId: "workspace-1" }),
      expect.any(String),
    );
  });
});
