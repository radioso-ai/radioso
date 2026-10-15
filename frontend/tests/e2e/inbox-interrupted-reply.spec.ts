import { expect, test } from "@playwright/test";

import {
  defaultAgentId,
  installDashboardApiMocks,
  nowIso,
  seedDashboardStorage,
  workspaceId,
  workspaceKey,
} from "./dashboard-fixtures";

// A voice caller who speaks over a reply cuts it short. The stored reply keeps its full text, so the
// Inbox marks it: the transcript must not read as if the caller heard all of it.
test("the Inbox marks a reply the caller spoke over and says about how much of it was heard", async ({ page }) => {
  const conversationId = "conversation-voice-interrupted";
  const conversation = {
    id: conversationId,
    agentId: defaultAgentId,
    agentName: "Gioia",
    agentInternalName: null,
    sourceChannel: "voice",
    sourceOrigin: null,
    entryPageUrl: null,
    channelContext: null,
    anonymousSessionId: null,
    createdAt: nowIso,
    updatedAt: nowIso,
    messageCount: 4,
    userMessageCount: 2,
    assistantMessageCount: 2,
    preview: "When do you open on Saturday?",
  };
  const conversationDetail = {
    conversationId,
    workspaceId,
    agentId: defaultAgentId,
    agentName: "Gioia",
    sourceChannel: "voice",
    sourceOrigin: null,
    channelContext: null,
    createdAt: nowIso,
    updatedAt: nowIso,
    messageCount: 4,
    userMessageCount: 2,
    assistantMessageCount: 2,
    messagesTotal: 4,
    messageWindowOffset: 0,
    messageWindowLimit: 50,
    hasOlderMessages: false,
    nextCursor: null,
    messages: [
      { id: "user-message-saturday", role: "user" as const, source: "customer" as const, content: "When do you open on Saturday?", createdAt: nowIso },
      {
        id: "assistant-message-cut-short",
        role: "assistant" as const,
        source: "ai_agent" as const,
        content: "We open at nine on weekdays and at ten on Saturdays, until six.",
        createdAt: nowIso,
        interruption: { heardCharacterCount: 23, spokenCharacterCount: 62 },
      },
      { id: "user-message-sunday", role: "user" as const, source: "customer" as const, content: "And Sunday?", createdAt: nowIso },
      { id: "assistant-message-heard", role: "assistant" as const, source: "ai_agent" as const, content: "We are closed on Sundays.", createdAt: nowIso },
    ],
  };

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    historyItems: {
      items: [{ kind: "chat", id: conversationId, sortAt: nowIso, conversation }],
      total: 1,
      nextCursor: null,
      hasMore: false,
    },
    conversationDetail,
  });

  await page.goto(`/w/${workspaceKey}/activity?tab=all&filter=chat&itemKind=chat&itemId=${conversationId}`);

  const response = page.getByLabel("Response", { exact: true });
  await expect(response.getByText("We are closed on Sundays.")).toBeVisible();
  const interrupted = response.getByText("Interrupted", { exact: true });
  await expect(interrupted).toHaveCount(1);

  await interrupted.hover();
  await expect(page.getByRole("tooltip")).toHaveText("The caller spoke over this reply. About 37% was heard.");
});
