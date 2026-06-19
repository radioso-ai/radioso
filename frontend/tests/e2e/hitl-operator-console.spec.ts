import { expect, test } from "@playwright/test";

import {
  accountId,
  installDashboardApiMocks,
  nowIso,
  seedDashboardStorage,
  workspaceId,
  workspaceKey,
} from "./dashboard-fixtures";

test("operator can take over, reply, and resolve a pending decision", async ({ page }) => {
  const conversationId = "conversation-hitl-1";
  const ownership = {
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
  };
  const humanOwnership = {
    ...ownership,
    state: "human_owned" as const,
    ownerAccountId: accountId,
    ownerDisplayName: "Test Operator",
    version: 2,
    takenOverAt: nowIso,
  };
  const historyList = {
    conversations: [
      {
        id: conversationId,
        agentId: null,
        agentName: null,
        sourceChannel: null,
        sourceOrigin: null,
        anonymousSessionId: null,
        createdAt: nowIso,
        updatedAt: nowIso,
        messageCount: 2,
        userMessageCount: 1,
        assistantMessageCount: 1,
        preview: "I need help with my booking",
        ownership,
      },
    ],
    total: 1,
    nextCursor: null,
    hasMore: false,
  };
  const conversationDetail = {
    conversationId,
    workspaceId,
    agentId: null,
    sourceChannel: null,
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
    ownership,
    messages: [
      {
        id: "customer-message-1",
        role: "user" as const,
        source: "customer" as const,
        content: "I need help with my booking",
        createdAt: nowIso,
      },
      {
        id: "assistant-message-1",
        role: "assistant" as const,
        source: "ai_agent" as const,
        content: "I can help with that.",
        createdAt: nowIso,
      },
    ],
  };
  const pendingDecision = {
    handle: "decision-1",
    conversationId,
    agentId: "agent-1",
    routineId: "routine-1",
    stepId: "step-1",
    reason: "Approve sending the booking update",
    options: [
      { id: "approve", label: "Approve" },
      { id: "reject", label: "Reject" },
    ],
    contentHash: "hash-1",
    deadline: null,
    createdAt: nowIso,
  };
  const humanReply = {
    id: "human-message-1",
    role: "assistant" as const,
    source: "human_agent" as const,
    content: "A human operator is checking your booking now.",
    createdAt: "2026-04-26T12:01:00.000Z",
  };

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    historyList,
    conversationDetail,
    pendingDecisions: [pendingDecision],
    takeOverConversationResponse: { ownership: humanOwnership },
    humanReplyResponse: {
      message: {
        ...humanReply,
        conversationId,
        workspaceId,
      },
    },
    conversationTailResponses: [
      { messages: [], cursor: "tail-1" },
      { messages: [humanReply], cursor: "tail-2", ownership: humanOwnership },
    ],
  });

  await page.goto(`/w/${workspaceKey}/activity`);
  await page.getByRole("button", { name: /I need help with my booking/ }).click();

  await expect(page.getByText("AI is handling this")).toBeVisible();
  await expect(page.getByRole("button", { name: "Take over" })).toBeVisible();
  await expect(page.getByText("Approve sending the booking update")).toBeVisible();

  await page.getByRole("button", { name: "Take over" }).click();
  await expect(page.getByText("Handled by Test Operator")).toBeVisible();

  await page.getByRole("textbox", { name: "Human reply" }).fill("A human operator is checking your booking now.");
  await page.getByRole("button", { name: "Send reply" }).click();

  await expect(page.getByText("A human operator is checking your booking now.")).toBeVisible();
  await expect(page.getByText("Human agent")).toBeVisible();

  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("Approve sending the booking update")).toHaveCount(0);
});

test("operator can take over an AI-owned conversation without an ownership version", async ({ page }) => {
  const conversationId = "conversation-hitl-no-ownership";
  const requestLog: string[] = [];
  const historyList = {
    conversations: [
      {
        id: conversationId,
        agentId: null,
        agentName: null,
        sourceChannel: null,
        sourceOrigin: null,
        anonymousSessionId: null,
        createdAt: nowIso,
        updatedAt: nowIso,
        messageCount: 1,
        userMessageCount: 1,
        assistantMessageCount: 0,
        preview: "Can a human check this?",
      },
    ],
    total: 1,
    nextCursor: null,
    hasMore: false,
  };
  const conversationDetail = {
    conversationId,
    workspaceId,
    agentId: null,
    sourceChannel: null,
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
    messages: [
      {
        id: "customer-message-no-ownership",
        role: "user" as const,
        source: "customer" as const,
        content: "Can a human check this?",
        createdAt: nowIso,
      },
    ],
  };

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    historyList,
    conversationDetail,
    conversationTailResponses: [{ messages: [], cursor: "tail-1" }],
    requestLog,
  });

  await page.goto(`/w/${workspaceKey}/activity`);
  await page.getByRole("button", { name: /Can a human check this/ }).click();

  const takeOverButton = page.getByRole("button", { name: "Take over" });
  await expect(takeOverButton).toBeEnabled();

  await takeOverButton.click();
  await expect(page.getByText("Handled by Test Operator")).toBeVisible();
  expect(requestLog).toContain(`POST /conversations/${conversationId}/takeover`);
});

test("pending approval cards are isolated when switching conversations", async ({ page }) => {
  const firstConversationId = "conversation-hitl-decision";
  const secondConversationId = "conversation-hitl-empty";
  const historyList = {
    conversations: [
      {
        id: firstConversationId,
        agentId: null,
        agentName: null,
        sourceChannel: null,
        sourceOrigin: null,
        anonymousSessionId: null,
        createdAt: nowIso,
        updatedAt: nowIso,
        messageCount: 1,
        userMessageCount: 1,
        assistantMessageCount: 0,
        preview: "First conversation needs approval",
      },
      {
        id: secondConversationId,
        agentId: null,
        agentName: null,
        sourceChannel: null,
        sourceOrigin: null,
        anonymousSessionId: null,
        createdAt: nowIso,
        updatedAt: nowIso,
        messageCount: 1,
        userMessageCount: 1,
        assistantMessageCount: 0,
        preview: "Second conversation has no approval",
      },
    ],
    total: 2,
    nextCursor: null,
    hasMore: false,
  };
  const buildConversationDetail = (conversationId: string, content: string) => ({
    conversationId,
    workspaceId,
    agentId: null,
    sourceChannel: null,
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
    messages: [
      {
        id: `${conversationId}-message-1`,
        role: "user" as const,
        source: "customer" as const,
        content,
        createdAt: nowIso,
      },
    ],
  });
  const pendingDecision = {
    handle: "shared-handle",
    conversationId: firstConversationId,
    agentId: "agent-1",
    routineId: "routine-1",
    stepId: "step-1",
    reason: "Only the first conversation should show this approval",
    options: [
      { id: "approve", label: "Approve" },
      { id: "reject", label: "Reject" },
    ],
    contentHash: "hash-1",
    deadline: null,
    createdAt: nowIso,
  };

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    historyList,
    conversationDetails: {
      [firstConversationId]: buildConversationDetail(firstConversationId, "First conversation needs approval"),
      [secondConversationId]: buildConversationDetail(secondConversationId, "Second conversation message body"),
    },
    pendingDecisions: [pendingDecision],
  });

  await page.goto(`/w/${workspaceKey}/activity`);
  await page.getByRole("button", { name: /First conversation needs approval/ }).click();
  await expect(page.getByText("Only the first conversation should show this approval")).toBeVisible();

  await page.getByRole("button", { name: "Close details panel" }).click();
  await expect(page.getByText("Only the first conversation should show this approval")).toHaveCount(0);
  await page.getByRole("button", { name: /Second conversation has no approval/ }).click();
  await expect(page.getByText("Second conversation message body")).toBeVisible();
  await expect(page.getByText("Only the first conversation should show this approval")).toHaveCount(0);
});
