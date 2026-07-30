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
    const isWrittenFeedback =
      new URL(route.request().url()).searchParams.get("hasComment") === "true";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: isWrittenFeedback ? [] : [
          {
            assistantMessageId: "message-degraded-inbox",
            conversationId: "conversation-degraded-inbox",
            agentId: "agent-1",
            agentName: "Concierge",
            channel: "authenticated_chat",
            question: "Do you sell gift cards?",
            answerPreview: "I could not find that in the documents.",
            skillName: "retrieval.answer",
            skillOutcome: "no_context",
            skillStatus: "completed",
            totalLatencyMs: 1200,
            createdAt: "2026-06-19T09:00:00.000Z",
            feedback: {
              upCount: 0,
              downCount: 0,
              latestDownUpdatedAt: null,
              comments: [],
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
          },
        ],
        total: isWrittenFeedback ? 0 : 14,
        page: 1,
        pageSize: isWrittenFeedback ? 25 : 1,
        totalPages: 1,
      }),
    });
  });

  // Activity defaults to the Needs attention inbox.
  await page.goto(`/w/${workspaceKey}/activity`);
  await expect(page.getByRole("link", { name: "Needs attention" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("button", { name: "Refresh" })).toBeVisible();

  // The tab selector sits in the page header actions; All activity is one click away.
  await page.getByRole("link", { name: "All activity" }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${workspaceKey}/activity\\?tab=all`));
  await expect(page.getByRole("table", { name: "Activity" })).toBeVisible();
  await page.getByRole("link", { name: "Needs attention" }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${workspaceKey}/activity$`));

  // One unified inbox table with an escalation-type column.
  const inbox = page.getByRole("table", { name: "Needs attention" });
  await expect(inbox).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve sending the booking update" })).toBeVisible();
  await expect(page.getByRole("button", { name: "A guest needs manual follow-up" })).toBeVisible();
  await expect(inbox.getByText("Awaiting a human")).toBeVisible();

  // Only work requiring an immediate human action appears as an inbox row.
  await expect(inbox.getByText("Approval", { exact: true })).toBeVisible();
  await expect(inbox.getByText("Handoff", { exact: true })).toBeVisible();
  await expect(inbox.getByText("No context", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Do you sell gift cards?" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Quality review" })).toBeVisible();
  await expect(page.getByText("14 answers flagged for review.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Review in Quality" })).toHaveAttribute(
    "href",
    `/w/${workspaceKey}/quality`,
  );

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
  await page.getByRole("link", { name: "Review in Quality" }).click();
  await expect(page).toHaveURL(`/w/${workspaceKey}/quality`);
  await expect(page.getByRole("heading", { name: "Quality review" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Quality" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("link", { name: "Quality", exact: true })).toHaveCount(1);
});

test("operator can turn written negative feedback into a remediation task", async ({ page }) => {
  const conversationId = "conversation-negative-feedback";
  const assistantMessageId = "assistant-negative-feedback";
  const triageRequests: Array<{
    state: string
    expectedVersion: number
    resolution?: { reason: string; note: string | null }
  }> = [];
  let acknowledgementAttempts = 0;
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
  const passiveTurn = {
    ...feedbackTurn,
    assistantMessageId: "assistant-passive-quality",
    conversationId: "conversation-passive-quality",
    question: "Do you sell gift cards?",
    answerPreview: "I could not find that in the documents.",
    skillOutcome: "no_context",
    createdAt: "2026-06-19T11:00:00.000Z",
    feedback: {
      upCount: 0,
      downCount: 0,
      latestDownUpdatedAt: null,
      comments: [],
    },
  };

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    historyList: {
      conversations: [{
        id: conversationId,
        agentId: defaultAgentId,
        agentName: "Marta",
        sourceChannel: "website_embed",
        sourceOrigin: "https://shop.example.com",
        anonymousSessionId: null,
        createdAt: nowIso,
        updatedAt: nowIso,
        messageCount: 4,
        userMessageCount: 2,
        assistantMessageCount: 2,
        preview: "Can I return an opened item?",
      }],
      total: 1,
      nextCursor: null,
      hasMore: false,
    },
    conversationDetail: {
      conversationId,
      workspaceId,
      agentId: defaultAgentId,
      sourceChannel: "website_embed",
      sourceOrigin: "https://shop.example.com",
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
          id: "customer-earlier",
          role: "user",
          source: "customer",
          content: "What is your standard return window?",
          createdAt: "2026-06-19T09:00:00.000Z",
        },
        {
          id: "assistant-earlier",
          role: "assistant",
          source: "ai_agent",
          content: "The standard return window is 30 days.",
          createdAt: "2026-06-19T09:01:00.000Z",
        },
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
          answerFeedbackEntries: [{
            id: "11111111-1111-4111-8111-111111111111",
            value: "down",
            comment: "This does not explain the opened-item exception.",
            actorType: "anonymous_user",
            actorId: "anonymous-session-1",
            accountId: null,
            userId: null,
            anonymousSessionId: "anonymous-session-1",
            createdAt: "2026-06-19T10:05:00.000Z",
            updatedAt: "2026-06-19T10:05:00.000Z",
          }],
        },
      ],
    },
  });

  await page.route("**/backend/api/v1/skills**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        skills: [{
          name: "retrieval.answer",
          outcomes: [{ name: "no_context", groundedAnswer: false }],
        }],
      }),
    });
  });

  await page.route("**/backend/api/v1/quality/turns**", async (route) => {
    const url = new URL(route.request().url());
    const isWrittenFeedback =
      url.searchParams.get("feedback") === "down"
      && url.searchParams.get("hasComment") === "true";
    const items = isWrittenFeedback ? [feedbackTurn] : [passiveTurn];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items,
        total: isWrittenFeedback ? 1 : 12,
        page: 1,
        pageSize: isWrittenFeedback ? 25 : 1,
        totalPages: 1,
      }),
    });
  });

  await page.route("**/backend/api/v1/quality/turns/*/triage**", async (route) => {
    const body = route.request().postDataJSON() as {
      state: string
      expectedVersion: number
      resolution?: { reason: string; note: string | null }
    };
    triageRequests.push(body);
    if (body.state === "acknowledged" && acknowledgementAttempts === 0) {
      acknowledgementAttempts += 1;
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "QUALITY_TRIAGE_CONFLICT",
            message: "Quality triage changed",
            details: {
              current: {
                state: "open",
                version: 3,
                resolution: null,
                legacyReason: null,
                closedAt: null,
                updatedAt: "2026-06-19T11:30:00.000Z",
              },
            },
          },
        }),
      });
      return;
    }
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
                resolution: {
                  reason: "expected_behavior",
                  note: "Policy already covers opened products.",
                },
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
        closedAt: body.state === "resolved" ? "2026-06-19T12:00:00.000Z" : null,
        updatedAt: "2026-06-19T12:00:00.000Z",
      }),
    });
  });

  await page.goto(`/w/${workspaceKey}/activity`);

  const inbox = page.getByRole("table", { name: "Needs attention" });
  await expect(inbox.getByText("Negative feedback", { exact: true })).toBeVisible();
  await expect(inbox.getByText("No context", { exact: true })).toHaveCount(0);
  await expect(page.getByText(
    "12 answers flagged for review. 1 includes written customer feedback.",
  )).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(inbox).toBeHidden();
  const mobileInbox = page.locator('div[aria-label="Needs attention"]');
  await expect(mobileInbox).toBeVisible();
  await mobileInbox.getByRole("button", {
    name: "Review feedback: Can I return an opened item?",
  }).click();

  const remediation = page.getByLabel("Negative feedback remediation");
  await expect(remediation.getByText(
    "Another operator already changed this feedback to open. Their current record has been loaded.",
  )).toBeVisible();
  await expect(remediation.getByRole("link", { name: /Add knowledge/ })).toBeEnabled();
  await page.getByRole("button", { name: "Close details panel" }).click();
  const feedbackReviewButton = mobileInbox.getByRole("button", {
    name: "Review feedback: Can I return an opened item?",
  });
  await feedbackReviewButton.click();
  await expect.poll(() => acknowledgementAttempts).toBe(1);
  await expect.poll(() =>
    triageRequests.filter(({ state }) => state === "acknowledged").length,
  ).toBe(2);

  const mobileDisclosure = remediation.getByRole("button", { name: "Negative feedback" });
  await expect(mobileDisclosure).toHaveAttribute("aria-expanded", "true");
  await mobileDisclosure.click();
  await expect(mobileDisclosure).toHaveAttribute("aria-expanded", "false");
  await mobileDisclosure.click();
  await expect(remediation.getByText(
    "This does not explain the opened-item exception.",
  )).toBeVisible();
  await expect(remediation.getByRole("link", { name: /Add knowledge/ })).toHaveAttribute(
    "target",
    "_blank",
  );
  await expect(remediation.getByRole("link", { name: /Add knowledge/ })).toHaveAttribute(
    "href",
    new RegExp(`/w/${workspaceKey}/knowledge`),
  );
  await expect(remediation.getByRole("link", { name: /Improve behavior/ })).toHaveAttribute(
    "target",
    "_blank",
  );
  await expect(remediation.getByRole("link", { name: /Improve behavior/ })).toHaveAttribute(
    "href",
    new RegExp(`/w/${workspaceKey}/agents/${defaultAgentId}.*tab=behavior`),
  );
  await expect(remediation.getByRole("link", { name: /Open agent chat/ })).toHaveAttribute(
    "href",
    `/w/${workspaceKey}/agents/${defaultAgentId}`,
  );

  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, "writeText", {
      configurable: true,
      value: async () => undefined,
    });
  });
  await remediation.getByRole("button", { name: "Copy question" }).click();
  await expect(remediation.getByText("Question copied.")).toBeVisible();

  const failedTurn = page.locator(`[data-message-id="${assistantMessageId}"]`);
  await expect(failedTurn).toBeVisible();
  await expect(failedTurn).toContainText("Items can be returned within 30 days.");

  await remediation.getByRole("button", { name: "Mark resolved" }).click();
  const resolutionDialog = page.getByRole("dialog");
  await expect(resolutionDialog.getByRole("heading", { name: "Resolve review" })).toBeVisible();
  await resolutionDialog.getByRole("button", { name: "Knowledge gap" }).click();
  await expect.poll(() => triageRequests).toContainEqual({
    state: "resolved",
    expectedVersion: 1,
    resolution: { reason: "knowledge_gap", note: null },
  });
  await expect(resolutionDialog.getByRole("heading", {
    name: "Another operator updated this review",
  })).toBeVisible();
  await expect(resolutionDialog.getByText("Dismissed", { exact: true })).toBeVisible();
  await expect(resolutionDialog.getByText("Expected behavior", { exact: true })).toBeVisible();
  await expect(resolutionDialog.getByText(
    "Policy already covers opened products.",
  )).toBeVisible();
  await expect(resolutionDialog.getByRole("button", {
    name: "Replace current decision",
  })).toBeDisabled();
  await expect(resolutionDialog.getByRole("button", {
    name: "Keep current decision",
  })).toBeVisible();
  await resolutionDialog.getByLabel(
    "I reviewed the current decision and want to replace it.",
  ).check();
  await resolutionDialog.getByRole("button", { name: "Replace current decision" }).click();
  await expect.poll(() => triageRequests).toContainEqual({
    state: "resolved",
    expectedVersion: 5,
    resolution: { reason: "knowledge_gap", note: null },
  });
  await expect(inbox.getByText("Negative feedback", { exact: true })).toHaveCount(0);
  await expect(page.locator("main").getByRole("status")).toContainText("Marked resolved.");
  await expect(page.getByText(
    "11 answers flagged for review.",
  )).toBeVisible();
  await expect(page.locator("main").getByText("Needs attention", { exact: true })).toBeFocused();
});

test("operator sees the expected feedback permission boundary without losing the inbox", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);

  await page.route("**/backend/api/v1/skills**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ skills: [] }),
    });
  });
  await page.route("**/backend/api/v1/quality/turns**", async (route) => {
    await route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({}),
    });
  });

  await page.goto(`/w/${workspaceKey}/activity`);

  await expect(page.getByText(
    "Answer feedback is available to workspace admins and owners. Approvals and handoffs are still shown.",
  )).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh" })).toBeEnabled();
  await expect(page.getByRole("link", { name: "Review in Quality" })).toHaveCount(0);
});
