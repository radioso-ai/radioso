import { expect, test, type Page } from "@playwright/test";

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
const conversationId = "conversation-voice-interrupted";
const cutReplyContent = "We open at nine on weekdays and at ten on Saturdays, until six.";
const interruption = { heardCharacterCount: 23, spokenCharacterCount: 62 };
const tooltip = "The caller spoke over this reply. About 37% was heard.";

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

const cutReply = (marked: boolean) => ({
  id: "assistant-message-cut-short",
  role: "assistant" as const,
  source: "ai_agent" as const,
  content: cutReplyContent,
  createdAt: nowIso,
  ...(marked ? { interruption } : {}),
});

const conversationDetail = (marked: boolean) => ({
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
    cutReply(marked),
    { id: "user-message-sunday", role: "user" as const, source: "customer" as const, content: "And Sunday?", createdAt: nowIso },
    { id: "assistant-message-heard", role: "assistant" as const, source: "ai_agent" as const, content: "We are closed on Sundays.", createdAt: nowIso },
  ],
});

const openConversation = async (page: Page, options: { marked: boolean }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    historyItems: {
      items: [{ kind: "chat", id: conversationId, sortAt: nowIso, conversation }],
      total: 1,
      nextCursor: null,
      hasMore: false,
    },
    conversationDetail: conversationDetail(options.marked),
  });
};

const response = (page: Page) => page.getByLabel("Response", { exact: true });
const readingPane = `/w/${workspaceKey}/activity?tab=all&filter=chat&itemKind=chat&itemId=${conversationId}`;

test("the Inbox marks a reply the caller spoke over and says about how much of it was heard", async ({ page }) => {
  await openConversation(page, { marked: true });
  await page.goto(readingPane);

  await expect(response(page).getByText("We are closed on Sundays.")).toBeVisible();
  const interrupted = response(page).getByText("Interrupted", { exact: true });
  await expect(interrupted).toHaveCount(1);

  await interrupted.hover();
  await expect(page.getByRole("tooltip")).toHaveText(tooltip);
});

test("an open conversation shows the mark once a later tail poll returns the marked reply again", async ({ page }) => {
  await openConversation(page, { marked: false });
  // The voice channel marks the reply on the caller's next request, after the pane has shown it; the
  // tail then returns the reply again with its marker.
  let markRecorded = false;
  let tailPolls = 0;
  await page.route(`**/backend/api/v1/history/chat/${conversationId}/tail**`, async (route) => {
    tailPolls += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ messages: markRecorded ? [cutReply(true)] : [], cursor: "tail-cursor" }),
    });
  });

  await page.goto(readingPane);
  await expect(response(page).getByText(cutReplyContent)).toBeVisible();
  await expect.poll(() => tailPolls).toBeGreaterThan(1);
  await expect(response(page).getByText("Interrupted", { exact: true })).toHaveCount(0);

  markRecorded = true;
  const interrupted = response(page).getByText("Interrupted", { exact: true });
  await expect(interrupted).toHaveCount(1);
  await expect(response(page).getByText(cutReplyContent)).toHaveCount(1);

  await interrupted.hover();
  await expect(page.getByRole("tooltip")).toHaveText(tooltip);
});
