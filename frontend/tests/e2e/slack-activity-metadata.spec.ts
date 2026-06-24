import { expect, test } from "@playwright/test";

import {
  installDashboardApiMocks,
  nowIso,
  seedDashboardStorage,
  workspaceId,
  workspaceKey,
} from "./dashboard-fixtures";

const baseConversation = (id: string, preview: string, channelContext: unknown) => ({
  id,
  sourceChannel: "authenticated_chat",
  sourceOrigin: null,
  channelContext,
  anonymousSessionId: null,
  createdAt: nowIso,
  updatedAt: nowIso,
  messageCount: 2,
  userMessageCount: 1,
  assistantMessageCount: 1,
  preview,
});

const detailFor = (conversation: ReturnType<typeof baseConversation>) => ({
  conversationId: conversation.id,
  workspaceId,
  sourceChannel: conversation.sourceChannel,
  sourceOrigin: conversation.sourceOrigin,
  channelContext: conversation.channelContext,
  createdAt: nowIso,
  updatedAt: nowIso,
  messageCount: conversation.messageCount,
  userMessageCount: conversation.userMessageCount,
  assistantMessageCount: conversation.assistantMessageCount,
  messagesTotal: 2,
  messageWindowOffset: 0,
  messageWindowLimit: 50,
  hasOlderMessages: false,
  nextCursor: null,
  tailCursor: null,
  messages: [
    {
      id: `${conversation.id}-user`,
      role: "user",
      source: "customer",
      content: conversation.preview,
      createdAt: nowIso,
    },
    {
      id: `${conversation.id}-assistant`,
      role: "assistant",
      source: "ai_agent",
      content: "Thanks, I can help with that.",
      createdAt: nowIso,
    },
  ],
});

test("Activity shows Slack metadata for DM and channel conversations while web chat stays unchanged", async ({ page }) => {
  const slackDm = baseConversation("slack-dm-conversation", "Slack DM question", {
    provider: "slack",
    team: { id: "T123", name: "Ausalt" },
    channel: { id: "D123", type: "im" },
    user: { id: "U123", displayName: "Dana" },
  });
  const slackChannel = baseConversation("slack-channel-conversation", "Slack channel mention", {
    provider: "slack",
    team: { id: "T123", name: "Ausalt" },
    channel: { id: "C123", type: "channel" },
    threadTs: "1712345678.000100",
    user: { id: "U456", displayName: "Lee" },
  });
  const webConversation = baseConversation("web-conversation", "Dashboard chat question", null);

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    historyList: {
      conversations: [slackDm, slackChannel, webConversation],
      total: 3,
      nextCursor: null,
      hasMore: false,
    },
    conversationDetails: {
      [slackDm.id]: detailFor(slackDm),
      [slackChannel.id]: detailFor(slackChannel),
      [webConversation.id]: detailFor(webConversation),
    },
  });

  await page.goto(`/w/${workspaceKey}/activity?tab=all`);

  await expect(page.getByRole("row", { name: /Slack DM question/ })).toContainText("Slack");
  await expect(page.getByRole("row", { name: /Slack DM question/ })).toContainText("Direct message with Dana");
  await expect(page.getByRole("row", { name: /Slack channel mention/ })).toContainText("Channel C123");
  await expect(page.getByRole("row", { name: /Slack channel mention/ })).toContainText("thread");
  await expect(page.getByRole("row", { name: /Dashboard chat question/ })).toContainText("Dashboard chat");
  await expect(page.getByRole("row", { name: /Dashboard chat question/ })).toContainText("Authenticated");

  await page.getByRole("button", { name: /Slack DM question/ }).click();
  const dmDrawer = page.getByLabel("Conversation details");
  await expect(dmDrawer).toContainText("Team Ausalt");
  await expect(dmDrawer).toContainText("Direct message with Dana");

  await page.goto(`/w/${workspaceKey}/activity?tab=all`);
  await page.getByRole("button", { name: /Slack channel mention/ }).click();
  const channelDrawer = page.getByLabel("Conversation details");
  await expect(channelDrawer).toContainText("Channel C123");
  await expect(channelDrawer).toContainText("User Lee");
  await expect(channelDrawer).toContainText("Thread");
});
