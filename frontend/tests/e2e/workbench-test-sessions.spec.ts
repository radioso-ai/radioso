import { expect, test } from "@playwright/test";

import {
  defaultAgentId,
  installDashboardApiMocks,
  nowIso,
  seedDashboardStorage,
  workspaceKey,
} from "./dashboard-fixtures";

// The workbench's "History" mode (TestSessionsView) — past operator test chats, shown as
// a Session | Messages | Updated table. Distinct from the Inbox "All" lens: it reads
// `/history/chat` scoped to `operator_test`, not the merged `/history` feed.

test("the workbench Sessions table shows the generated topic title over the raw first message, and falls back when absent", async ({ page }) => {
  const titledSession = {
    id: "session-titled",
    agentId: defaultAgentId,
    agentName: "Gioia",
    agentInternalName: null,
    sourceChannel: "authenticated_chat",
    sourceOrigin: null,
    entryPageUrl: null,
    channelContext: null,
    anonymousSessionId: null,
    createdAt: nowIso,
    updatedAt: nowIso,
    messageCount: 5,
    userMessageCount: 2,
    assistantMessageCount: 3,
    preview: "sqrt(5)",
    title: "Square root calculation walkthrough",
  };
  const untitledSession = {
    id: "session-untitled",
    agentId: defaultAgentId,
    agentName: "Gioia",
    agentInternalName: null,
    sourceChannel: "authenticated_chat",
    sourceOrigin: null,
    entryPageUrl: null,
    channelContext: null,
    anonymousSessionId: null,
    createdAt: nowIso,
    updatedAt: nowIso,
    messageCount: 2,
    userMessageCount: 1,
    assistantMessageCount: 1,
    preview: "hi",
  };

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    historyList: {
      conversations: [titledSession, untitledSession],
      total: 2,
      nextCursor: null,
      hasMore: false,
    },
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=chat`);
  await page.getByRole("button", { name: "History", exact: true }).click();

  // Titled session shows the generated topic, not the raw first message.
  await expect(page.getByRole("button", { name: "Square root calculation walkthrough" })).toBeVisible();
  await expect(page.getByRole("button", { name: "sqrt(5)", exact: true })).toHaveCount(0);
  // A session with no title yet still falls back to its raw first message — it is never
  // blank and never says "Untitled test session" while a real preview exists.
  await expect(page.getByRole("button", { name: "hi", exact: true })).toBeVisible();
});
