import { expect, test } from "@playwright/test";

import {
  accountId,
  defaultAgentId,
  installDashboardApiMocks,
  nowIso,
  seedDashboardStorage,
  workspaceId,
  workspaceKey,
} from "./dashboard-fixtures";

test("operator opens the inbox, replies to a handoff, marks it done, and the debug drawer stays builder-only", async ({ page }) => {
  const conversationId = "conversation-hitl-inbox";
  const requestLog: string[] = [];
  const ownership = {
    conversationId,
    workspaceId,
    state: "human_owned" as const,
    ownerAccountId: null,
    ownerDisplayName: null,
    reason: "agent had no weekly schedule information",
    version: 1,
    takenOverAt: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  const humanOwnership = {
    ...ownership,
    ownerAccountId: accountId,
    ownerDisplayName: "Test Operator",
    version: 2,
    takenOverAt: nowIso,
  };
  const historyList = {
    conversations: [
      {
        id: conversationId,
        agentId: defaultAgentId,
        agentName: "Gioia",
        sourceChannel: "authenticated_chat",
        sourceOrigin: null,
        anonymousSessionId: null,
        entryPageUrl: "https://corsi.example.com/yoga?utm_source=newsletter&utm_medium=email",
        createdAt: nowIso,
        updatedAt: nowIso,
        messageCount: 2,
        userMessageCount: 1,
        assistantMessageCount: 1,
        preview: "Weekly yoga schedule",
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
    agentId: defaultAgentId,
    agentName: "Gioia",
    sourceChannel: "authenticated_chat",
    sourceOrigin: null,
    entryPageUrl: "https://corsi.example.com/yoga?utm_source=newsletter&utm_medium=email",
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
        id: "customer-message-inbox",
        role: "user" as const,
        source: "customer" as const,
        content: "dove trovo gli orari dei corsi di yoga settimanali",
        createdAt: nowIso,
      },
      {
        id: "assistant-message-inbox",
        role: "assistant" as const,
        source: "ai_agent" as const,
        content: "Per gli orari aggiornati, contatta la reception.",
        createdAt: nowIso,
      },
    ],
  };

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    historyList,
    conversationDetail,
    takeOverConversationResponse: { ownership: humanOwnership },
    handBackConversationResponse: {
      ownership: { ...humanOwnership, state: "ai_owned", ownerAccountId: null, ownerDisplayName: null, version: 3 },
    },
    requestLog,
  });

  await page.route("**/backend/api/v1/quality/turns**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [], total: 0, page: 1, pageSize: 25, totalPages: 1 }),
    });
  });

  // Activity defaults to the Inbox sub-tab.
  await page.goto(`/w/${workspaceKey}/activity`);
  await expect(page.getByRole("link", { name: "Inbox" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible();

  const queue = page.getByLabel("Inbox queue");
  const handoffRow = queue.getByRole("button", { name: /Weekly yoga schedule/ });
  await expect(handoffRow).toBeVisible();
  await expect(handoffRow).toContainText("Handoff");

  await handoffRow.click();

  const response = page.getByLabel("Response", { exact: true });
  await expect(response.getByText("Verified visitor")).toBeVisible();
  await expect(response.getByRole("link", { name: "https://corsi.example.com/yoga" })).toBeVisible();
  await expect(response.getByText(/Handed off — agent had no weekly schedule information/)).toBeVisible();
  // The situation card quotes the visitor's opening message as context, and the
  // message thread below renders the same message in full — both legitimately
  // match this text, so disambiguate to the situation card's copy (it renders
  // first in DOM order).
  await expect(response.getByText("dove trovo gli orari dei corsi di yoga settimanali").first()).toBeVisible();

  const replyBox = response.getByRole("textbox", { name: "Reply to the visitor" });
  await replyBox.fill("Ecco gli orari aggiornati dei corsi di yoga.");
  await response.getByRole("button", { name: "Send" }).click();

  await expect.poll(() => requestLog).toContainEqual(`POST /conversations/${conversationId}/takeover`);
  await expect.poll(() => requestLog).toContainEqual(`POST /conversations/${conversationId}/reply`);
  await expect(replyBox).toHaveValue("");

  // The response view's only link into the drawer is quiet, and the drawer it
  // opens carries zero operator mutation controls (spec 1116 User Story 4).
  await response.getByRole("button", { name: "Open in debug view" }).click();
  const drawer = page.getByLabel("Conversation details");
  await expect(page.getByRole("heading", { name: "Conversation details" })).toBeAttached();
  await expect(drawer.getByText("dove trovo gli orari dei corsi di yoga settimanali")).toBeVisible();
  await expect(drawer.getByRole("textbox", { name: "Reply to the visitor" })).toHaveCount(0);
  await expect(drawer.getByRole("button", { name: "Take over" })).toHaveCount(0);
  await expect(drawer.getByRole("button", { name: "Hand back to AI" })).toHaveCount(0);
  // Exact match: the drawer's message thread legitimately renders a "Send to
  // eval" action (evalCaptureEnabled), which a substring match on "Send" would
  // also catch. This assertion only cares about the operator reply composer's
  // Send button, which is what "spec 1116 User Story 4" keeps out of the drawer.
  await expect(drawer.getByRole("button", { name: "Send", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Close details panel" }).click();

  // Done hands the conversation back to the agent - the single wrap-up action.
  await response.getByRole("button", { name: "Done" }).click();
  await expect.poll(() => requestLog).toContainEqual(`POST /conversations/${conversationId}/handback`);
});

test("operator resolves a pending decision from the response view", async ({ page }) => {
  const conversationId = "conversation-hitl-approval";
  const pendingDecision = {
    handle: "decision-inbox-1",
    conversationId,
    agentId: defaultAgentId,
    routineId: "routine-1",
    stepId: "step-1",
    reason: "Apply a 20% goodwill discount?",
    options: [
      { id: "approve", label: "Approve", description: "Issue the 20% discount." },
      { id: "reject", label: "Reject" },
    ],
    contentHash: "hash-1",
    canResolve: true,
    deadline: null,
    createdAt: nowIso,
  };
  const conversationDetail = {
    conversationId,
    workspaceId,
    agentId: defaultAgentId,
    agentName: "Gioia",
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
        id: "customer-message-approval",
        role: "user" as const,
        source: "customer" as const,
        content: "My order arrived damaged, can I get a discount?",
        createdAt: nowIso,
      },
    ],
  };

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    conversationDetail,
    pendingDecisions: [pendingDecision],
  });
  await page.route("**/backend/api/v1/quality/turns**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [], total: 0, page: 1, pageSize: 25, totalPages: 1 }),
    });
  });

  await page.goto(`/w/${workspaceKey}/activity`);
  const queue = page.getByLabel("Inbox queue");
  await queue.getByRole("button", { name: /Apply a 20% goodwill discount/ }).click();

  const response = page.getByLabel("Response", { exact: true });
  const decisionPanel = response.getByLabel("Pending approval");
  await expect(decisionPanel.getByText("Apply a 20% goodwill discount?")).toBeVisible();
  // Approvals close on decision, not on a separate Done control.
  await expect(response.getByRole("button", { name: "Done" })).toHaveCount(0);

  await decisionPanel.getByRole("button", { name: "Approve" }).click();
  await expect(queue.getByRole("button", { name: /Apply a 20% goodwill discount/ })).toHaveCount(0);
});

test("operator resolves negative feedback through Done, surviving a version conflict", async ({ page }) => {
  const conversationId = "conversation-negative-feedback";
  const assistantMessageId = "assistant-negative-feedback";
  const triageRequests: Array<{
    state: string;
    expectedVersion: number;
    resolution?: { reason: string; note: string | null };
  }> = [];
  let resolutionAttempts = 0;
  const feedbackTurn = {
    assistantMessageId,
    conversationId,
    agentId: defaultAgentId,
    agentName: "Marta",
    channel: "website_embed",
    question: "Can I return an opened item?",
    answerPreview: "Items can be returned within 30 days.",
    skillName: "retrieval.answer",
    skillOutcome: "grounded",
    skillStatus: "completed",
    totalLatencyMs: 900,
    createdAt: "2026-06-19T10:00:00.000Z",
    feedback: {
      upCount: 0,
      downCount: 1,
      latestDownUpdatedAt: "2026-06-19T10:05:00.000Z",
      comments: [{
        value: "down",
        comment: "This does not explain the opened-item exception.",
        createdAt: "2026-06-19T10:05:00.000Z",
        updatedAt: "2026-06-19T10:05:00.000Z",
      }],
    },
    triage: {
      state: "open",
      version: 0,
      resolution: null,
      legacyReason: null,
      closedAt: null,
      updatedAt: null,
    },
    verification: null,
  };

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    conversationDetail: {
      conversationId,
      workspaceId,
      agentId: defaultAgentId,
      sourceChannel: "website_embed",
      sourceOrigin: "https://shop.example.com",
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
        state: "ai_owned",
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
          id: "customer-negative-feedback",
          role: "user",
          source: "customer",
          content: "Can I return an opened item?",
          createdAt: "2026-06-19T10:00:00.000Z",
        },
        {
          id: assistantMessageId,
          role: "assistant",
          source: "ai_agent",
          content: "Items can be returned within 30 days.",
          createdAt: "2026-06-19T10:01:00.000Z",
        },
      ],
    },
  });

  await page.route("**/backend/api/v1/quality/turns**", async (route) => {
    const url = new URL(route.request().url());
    const isWrittenFeedback =
      url.searchParams.get("feedback") === "down" && url.searchParams.get("hasComment") === "true";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: isWrittenFeedback ? [feedbackTurn] : [],
        total: isWrittenFeedback ? 1 : 0,
        page: 1,
        pageSize: isWrittenFeedback ? 25 : 1,
        totalPages: 1,
      }),
    });
  });

  await page.route("**/backend/api/v1/quality/turns/*/triage**", async (route) => {
    const body = route.request().postDataJSON() as {
      state: string;
      expectedVersion: number;
      resolution?: { reason: string; note: string | null };
    };
    triageRequests.push(body);
    if (body.state === "resolved" && resolutionAttempts === 0) {
      resolutionAttempts += 1;
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "QUALITY_TRIAGE_CONFLICT",
            message: "Quality triage changed",
            details: {
              current: {
                state: "dismissed",
                version: 5,
                resolution: { reason: "expected_behavior", note: "Policy already covers opened products." },
                legacyReason: null,
                closedAt: "2026-06-19T11:45:00.000Z",
                updatedAt: "2026-06-19T11:45:00.000Z",
              },
            },
          },
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        state: body.state,
        version: body.expectedVersion + 1,
        resolution: body.resolution ?? null,
        legacyReason: null,
        closedAt: "2026-06-19T12:00:00.000Z",
        updatedAt: "2026-06-19T12:00:00.000Z",
      }),
    });
  });

  await page.goto(`/w/${workspaceKey}/activity`);
  const queue = page.getByLabel("Inbox queue");
  const feedbackRow = queue.getByRole("button", { name: /Can I return an opened item\?/ });
  await expect(feedbackRow).toBeVisible();
  await feedbackRow.click();
  // Selecting a feedback item acknowledges it in the background.
  await expect.poll(() => triageRequests.some((r) => r.state === "acknowledged")).toBe(true);

  const response = page.getByLabel("Response", { exact: true });
  await response.getByRole("button", { name: "Done" }).click();

  await expect(page.getByRole("heading", { name: "Resolve review" })).toBeVisible();
  await page.getByRole("button", { name: "Knowledge gap" }).click();

  await expect(page.getByRole("heading", { name: "Another operator updated this review" })).toBeVisible();
  await page.getByLabel("I reviewed the current decision and want to replace it.").check();
  await page.getByRole("button", { name: "Replace current decision" }).click();

  // The conflict response carries version 5; replacing it resubmits at that version.
  await expect.poll(() => triageRequests).toContainEqual({
    state: "resolved",
    expectedVersion: 5,
    resolution: { reason: "knowledge_gap", note: null },
  });
  await expect(queue.getByRole("button", { name: /Can I return an opened item\?/ })).toHaveCount(0);
});

test("operator sees the expected feedback permission boundary without losing the inbox", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);

  await page.route("**/backend/api/v1/quality/turns**", async (route) => {
    await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({}) });
  });

  await page.goto(`/w/${workspaceKey}/activity`);

  await expect(page.getByText("New handoffs, approvals, and written customer feedback will appear here.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Review in Quality" })).toHaveCount(0);
});
