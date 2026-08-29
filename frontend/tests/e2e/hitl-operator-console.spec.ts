import { expect, test } from "@playwright/test";

import {
  installDashboardApiMocks,
  nowIso,
  seedDashboardStorage,
  workspaceId,
  workspaceKey,
} from "./dashboard-fixtures";

// The conversation drawer used to be the only reply/take-over/hand-back/decision
// surface (the "operator console"). Spec 1116 moved all of that to the inbox's
// response view and made the drawer builder-only everywhere it mounts,
// including from Conversations (All activity) - covered here. The inbox's own
// journey (select item -> reply claims -> Done) lives in
// hitl-needs-attention.spec.ts, which also checks the drawer opened from its
// "Open in debug view" link.
test("drawer opened from Conversations carries no operator mutation controls", async ({ page }) => {
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
    canResolve: true,
    deadline: null,
    createdAt: nowIso,
  };

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    historyList,
    conversationDetail,
    pendingDecisions: [pendingDecision],
  });

  await page.goto(`/w/${workspaceKey}/activity?tab=all`);
  await page.getByRole("button", { name: /I need help with my booking/ }).click();
  // Selecting a conversation in the All lens opens the reading pane, not the
  // drawer; the drawer is reached through its quiet "Open in debug view" link
  // (spec 1116 User Story 4).
  await page.getByRole("button", { name: "Open in debug view" }).click();

  const drawer = page.getByLabel("Conversation details");
  await expect(page.getByRole("heading", { name: "Conversation details" })).toBeAttached();
  await expect(drawer.getByText("I need help with my booking")).toBeVisible();

  // No reply/take-over/hand-back/decision controls anywhere in the drawer, even
  // though a pending decision exists for this conversation and it is AI-owned
  // (both would have rendered operator controls before spec 1116).
  await expect(drawer.getByRole("textbox", { name: "Reply to the visitor" })).toHaveCount(0);
  await expect(drawer.getByRole("textbox", { name: "Human reply" })).toHaveCount(0);
  await expect(drawer.getByRole("button", { name: "Take over" })).toHaveCount(0);
  await expect(drawer.getByRole("button", { name: "Hand back to AI" })).toHaveCount(0);
  await expect(drawer.getByRole("button", { name: "Send reply" })).toHaveCount(0);
  await expect(drawer.getByRole("button", { name: "Approve" })).toHaveCount(0);
  await expect(drawer.getByRole("button", { name: "Reject" })).toHaveCount(0);
  await expect(drawer.getByText("Approve sending the booking update")).toHaveCount(0);
  await expect(drawer.getByText("AI is handling this")).toHaveCount(0);

  // Builder tooling is still there.
  await expect(page.getByRole("button", { name: "Debug" })).toBeVisible();
});
