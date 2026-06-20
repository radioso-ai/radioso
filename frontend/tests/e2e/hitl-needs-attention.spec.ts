import { expect, test } from "@playwright/test";

import {
  defaultAgentId,
  installDashboardApiMocks,
  nowIso,
  seedDashboardStorage,
  workspaceId,
  workspaceKey,
} from "./dashboard-fixtures";

test("operator can use activity tabs to open a pending approval", async ({ page }) => {
  const conversationId = "conversation-hitl-inbox";
  const humanConversationId = "conversation-human-owned-inbox";
  const aiConversationId = "conversation-ai-owned-inbox";
  const humanOwnership = {
    conversationId: humanConversationId,
    workspaceId,
    state: "human_owned" as const,
    ownerAccountId: null,
    ownerDisplayName: null,
    reason: "requested_handoff",
    version: 2,
    takenOverAt: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  const historyList = {
    conversations: [
      {
        id: conversationId,
        agentId: defaultAgentId,
        agentName: "Marta",
        sourceChannel: "authenticated_chat",
        sourceOrigin: null,
        anonymousSessionId: null,
        createdAt: nowIso,
        updatedAt: nowIso,
        messageCount: 2,
        userMessageCount: 1,
        assistantMessageCount: 1,
        preview: "Please send the booking update",
      },
      {
        id: humanConversationId,
        agentId: defaultAgentId,
        agentName: "Marta",
        sourceChannel: "authenticated_chat",
        sourceOrigin: null,
        anonymousSessionId: null,
        createdAt: nowIso,
        updatedAt: nowIso,
        messageCount: 1,
        userMessageCount: 1,
        assistantMessageCount: 0,
        preview: "A guest needs manual follow-up",
        ownership: humanOwnership,
      },
      {
        id: aiConversationId,
        agentId: defaultAgentId,
        agentName: "Marta",
        sourceChannel: "authenticated_chat",
        sourceOrigin: null,
        anonymousSessionId: null,
        createdAt: nowIso,
        updatedAt: nowIso,
        messageCount: 1,
        userMessageCount: 1,
        assistantMessageCount: 0,
        preview: "The AI can keep handling this",
      },
    ],
    total: 3,
    nextCursor: null,
    hasMore: false,
  };
  const conversationDetail = {
    conversationId,
    workspaceId,
    agentId: defaultAgentId,
    sourceChannel: "authenticated_chat",
    sourceOrigin: null,
    createdAt: nowIso,
    updatedAt: nowIso,
    messageCount: 2,
    userMessageCount: 1,
    assistantMessageCount: 1,
    messagesTotal: 2,
    messageWindowOffset: 0,
    messageWindowLimit: 50,
    hasOlderMessages: false,
    nextCursor: null,
    ownership: {
      conversationId,
      workspaceId,
      state: "ai_owned" as const,
      ownerAccountId: null,
      ownerDisplayName: null,
      reason: null,
      version: 1,
      takenOverAt: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    },
    messages: [
      {
        id: "customer-message-inbox",
        role: "user" as const,
        source: "customer" as const,
        content: "Please send the booking update",
        createdAt: nowIso,
      },
      {
        id: "assistant-message-inbox",
        role: "assistant" as const,
        source: "ai_agent" as const,
        content: "I can prepare that update.",
        createdAt: nowIso,
      },
    ],
  };
  const humanConversationDetail = {
    conversationId: humanConversationId,
    workspaceId,
    agentId: defaultAgentId,
    sourceChannel: "authenticated_chat",
    sourceOrigin: null,
    createdAt: nowIso,
    updatedAt: nowIso,
    messageCount: 1,
    userMessageCount: 1,
    assistantMessageCount: 0,
    messagesTotal: 1,
    messageWindowOffset: 0,
    messageWindowLimit: 50,
    hasOlderMessages: false,
    nextCursor: null,
    ownership: humanOwnership,
    messages: [
      {
        id: "customer-message-human-owned",
        role: "user" as const,
        source: "customer" as const,
        content: "A guest needs manual follow-up",
        createdAt: nowIso,
      },
    ],
  };
  const pendingDecision = {
    handle: "decision-inbox-1",
    conversationId,
    agentId: defaultAgentId,
    routineId: "routine-1",
    stepId: "step-1",
    reason: "Approve sending the booking update",
    options: [
      { id: "approve", label: "Approve" },
      { id: "reject", label: "Reject" },
    ],
    contentHash: "hash-1",
    canResolve: true,
    deadline: null,
    createdAt: nowIso,
  };

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    historyList,
    conversationDetail,
    conversationDetails: {
      [humanConversationId]: humanConversationDetail,
    },
    pendingDecisions: [pendingDecision],
  });

  await page.route("**/backend/api/v1/quality/turns**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: [],
        total: 0,
        page: 1,
        pageSize: 25,
        totalPages: 0,
      }),
    });
  });

  await page.goto(`/w/${workspaceKey}/activity`);
  await expect(page.getByRole("link", { name: "All activity" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("table", { name: "Activity" })).toBeVisible();

  await page.getByRole("link", { name: "Needs attention" }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${workspaceKey}/activity\\?tab=needs-attention`));
  await expect(page.getByRole("button", { name: "Refresh" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Pending approvals" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve sending the booking update" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Awaiting / handled by a human" })).toBeVisible();
  await expect(page.getByRole("button", { name: "A guest needs manual follow-up" })).toBeVisible();
  await expect(page.getByText("Awaiting a human")).toBeVisible();
  await expect(page.getByText("The AI can keep handling this")).toHaveCount(0);

  await page.getByRole("button", { name: "Approve sending the booking update" }).click();
  await expect(page.getByRole("heading", { name: "Conversation details" })).toBeAttached();
  await expect(page.getByLabel("Conversation details").getByText("Approve sending the booking update")).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve" })).toBeVisible();

  await page.getByRole("button", { name: "Close details panel" }).click();
  await page.getByRole("button", { name: "A guest needs manual follow-up" }).click();
  await expect(page.getByRole("heading", { name: "Conversation details" })).toBeAttached();
  await expect(page.getByLabel("Conversation details").getByText("A guest needs manual follow-up")).toBeVisible();
  await expect(page.getByText("Waiting for a human")).toBeVisible();

  await page.getByRole("button", { name: "Close details panel" }).click();
  await page.getByRole("link", { name: "Quality" }).click();
  await expect(page).toHaveURL(`/w/${workspaceKey}/quality`);
  await expect(page.getByRole("heading", { name: "Quality review" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Quality" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("link", { name: "Quality", exact: true })).toHaveCount(1);
});
