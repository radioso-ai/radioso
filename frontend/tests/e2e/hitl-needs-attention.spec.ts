import { expect, test } from "@playwright/test";

import {
  accountId,
  currentUserId,
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
    ownerUserId: null,
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
    ownerUserId: currentUserId,
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
      ownership: { ...humanOwnership, state: "ai_owned", ownerAccountId: null, ownerUserId: null, ownerDisplayName: null, version: 3 },
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

  // The Inbox page defaults to the Needs-you lens, shown via the segmented
  // toggle at the top of the left pane (spec 1116 unification).
  await page.goto(`/w/${workspaceKey}/activity`);
  await expect(page.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: /Needs you/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "All", exact: true })).toHaveAttribute("aria-pressed", "false");

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
  await expect(drawer.getByRole("button", { name: "Reassign" })).toHaveCount(0);
  await expect(drawer.getByRole("button", { name: "Assign", exact: true })).toHaveCount(0);
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

  await page.goto(`/w/${workspaceKey}/activity?tab=needs-attention`);
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

  await page.goto(`/w/${workspaceKey}/activity?tab=needs-attention`);

  // A 403 on quality data means the empty state must not promise a feedback
  // channel the operator can't load — handoffs/approvals still work.
  await expect(page.getByText("New handoffs and approvals will appear here.")).toBeVisible();
  await expect(page.getByText("You don't have permission to view quality feedback.")).toBeVisible();
  await expect(page.getByRole("link", { name: /flagged for quality review/ })).toHaveCount(0);
});

test("the smart default lens stays on Needs-you when quality fails to load, even with an otherwise-empty reading", async ({ page }) => {
  // No explicit ?tab= — this is the exact path the smart-default-lens
  // decision runs on. Decisions and human-owned conversations are both
  // empty (the default mocks), so the only reason a redirect to All would be
  // wrong is the quality 403: an empty *reading* while quality couldn't load
  // isn't a trustworthy "genuinely nothing needs you," and the operator must
  // see the permission-denied state instead of silently landing on All.
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);
  await page.route("**/backend/api/v1/quality/turns**", async (route) => {
    await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({}) });
  });

  await page.goto(`/w/${workspaceKey}/activity`);

  await expect(page.getByText("You don't have permission to view quality feedback.")).toBeVisible();
  await expect(page).not.toHaveURL(/tab=all/);
  const toggle = page.getByLabel("Inbox queue").getByRole("group", { name: "Inbox lens" });
  await expect(toggle.getByRole("button", { name: /Needs you/ })).toHaveAttribute("aria-pressed", "true");
});

test("operator opens a recently closed feedback conversation from Needs-you", async ({ page }) => {
  const conversationId = "conversation-recently-closed-feedback";
  const assistantMessageId = "assistant-recently-closed-feedback";
  const closedAt = "2026-06-20T23:12:00.000Z";
  const closedTurn = {
    assistantMessageId,
    conversationId,
    agentId: defaultAgentId,
    agentName: "Marta",
    channel: "website_embed",
    question: "Who is Nikola Tesla?",
    answerPreview: "Nikola Tesla was an inventor and electrical engineer.",
    skillName: "retrieval.answer",
    skillOutcome: "grounded",
    skillStatus: "completed",
    totalLatencyMs: 900,
    createdAt: "2026-06-20T23:00:00.000Z",
    feedback: {
      upCount: 0,
      downCount: 1,
      latestDownUpdatedAt: "2026-06-20T23:05:00.000Z",
      comments: [{
        value: "down",
        comment: "Needed a source.",
        createdAt: "2026-06-20T23:05:00.000Z",
        updatedAt: "2026-06-20T23:05:00.000Z",
      }],
    },
    triage: {
      state: "resolved",
      version: 2,
      resolution: { reason: "expected_behavior", note: null },
      legacyReason: null,
      closedAt,
      updatedAt: closedAt,
    },
    verification: null,
  };

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    conversationDetail: {
      conversationId,
      workspaceId,
      agentId: defaultAgentId,
      agentName: "Marta",
      sourceChannel: "website_embed",
      sourceOrigin: "https://knowledge.example.com",
      createdAt: "2026-06-20T23:00:00.000Z",
      updatedAt: "2026-06-20T23:12:00.000Z",
      messageCount: 2,
      userMessageCount: 1,
      assistantMessageCount: 1,
      messagesTotal: 2,
      messageWindowOffset: 0,
      messageWindowLimit: 50,
      hasOlderMessages: false,
      nextCursor: null,
      messages: [
        {
          id: "customer-recently-closed-feedback",
          role: "user" as const,
          source: "customer" as const,
          content: "Who is Nikola Tesla?",
          createdAt: "2026-06-20T23:00:00.000Z",
        },
        {
          id: assistantMessageId,
          role: "assistant" as const,
          source: "ai_agent" as const,
          content: "Nikola Tesla was an inventor and electrical engineer.",
          createdAt: "2026-06-20T23:01:00.000Z",
        },
      ],
    },
  });
  await page.route("**/backend/api/v1/quality/turns**", async (route) => {
    const url = new URL(route.request().url());
    const isRecentlyClosed = url.searchParams.get("triage") === "dismissed,resolved";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: isRecentlyClosed ? [closedTurn] : [],
        total: isRecentlyClosed ? 1 : 0,
        page: 1,
        pageSize: isRecentlyClosed ? 10 : 25,
        totalPages: isRecentlyClosed ? 1 : 0,
      }),
    });
  });

  await page.goto(`/w/${workspaceKey}/activity?tab=needs-attention`);

  const queue = page.getByLabel("Inbox queue");
  const closedRow = queue.getByRole("button", { name: /Who is Nikola Tesla\?/ });
  await expect(closedRow).toBeVisible();
  await expect(closedRow).toContainText("Resolved");

  await closedRow.click();

  const response = page.getByLabel("Response", { exact: true });
  await expect(closedRow).toHaveAttribute("aria-current", "true");
  await expect(response.getByText("Who is Nikola Tesla?")).toBeVisible();
  await expect(response.getByText("Nikola Tesla was an inventor and electrical engineer.")).toBeVisible();
  await expect(response.getByRole("textbox", { name: "Reply to the visitor" })).toHaveCount(0);
});

test("an empty Needs-you queue hides the filters, keeps the toggle in the left pane, and puts the confidence message in the reading pane", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);
  await page.route("**/backend/api/v1/quality/turns**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [], total: 0, page: 1, pageSize: 25, totalPages: 1 }),
    });
  });

  await page.goto(`/w/${workspaceKey}/activity?tab=needs-attention`);

  // Zero open items still renders the two-pane shell with its toggle in the
  // left pane, but there is nothing to search or filter, so those controls
  // hide rather than sitting there inert.
  const queue = page.getByLabel("Inbox queue");
  const toggle = queue.getByRole("group", { name: "Inbox lens" });
  await expect(toggle).toBeVisible();
  await expect(toggle.getByRole("button", { name: /Needs you/ })).toHaveAttribute("aria-pressed", "true");
  await expect(queue.getByPlaceholder("Search inbox")).toHaveCount(0);
  await expect(queue.getByLabel("Filter by type")).toHaveCount(0);
  await expect(queue.getByLabel("Filter by agent")).toHaveCount(0);
  await expect(queue.getByLabel("Filter by taken by")).toHaveCount(0);

  // "Select an item from the queue to respond" is not actionable advice when
  // the queue is empty — the confidence/empty-queue message renders in the
  // reading pane instead, not stranded in the now filter-less left pane.
  const response = page.getByLabel("Response", { exact: true });
  await expect(response.getByText("Nothing needs you right now")).toBeVisible();
  await expect(queue.getByText("Nothing needs you right now")).toHaveCount(0);

  await toggle.getByRole("button", { name: "All", exact: true }).click();
  await expect(page).toHaveURL(/tab=all/);
  await expect(page.getByRole("complementary", { name: "Conversations" })).toBeVisible();
});

test("the recently-closed strip shows the resolution and when it was closed", async ({ page }) => {
  const conversationId = "conversation-recently-closed";
  const assistantMessageId = "assistant-recently-closed";
  const closedAtIso = "2026-08-26T16:40:00.000Z";
  const dismissedTurn = {
    assistantMessageId,
    conversationId,
    agentId: defaultAgentId,
    agentName: "Marta",
    channel: "website_embed",
    question: "Do you ship internationally?",
    answerPreview: "We currently only ship within the EU.",
    skillName: "retrieval.answer",
    skillOutcome: "grounded",
    skillStatus: "completed",
    totalLatencyMs: 800,
    createdAt: "2026-08-26T16:00:00.000Z",
    feedback: {
      upCount: 0,
      downCount: 1,
      latestDownUpdatedAt: "2026-08-26T16:05:00.000Z",
      comments: [{
        value: "down",
        comment: "Doesn't mention international shipping timelines.",
        createdAt: "2026-08-26T16:05:00.000Z",
        updatedAt: "2026-08-26T16:05:00.000Z",
      }],
    },
    triage: {
      state: "dismissed",
      version: 1,
      resolution: { reason: "expected_behavior", note: null },
      legacyReason: null,
      closedAt: closedAtIso,
      updatedAt: closedAtIso,
    },
    verification: null,
  };

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);
  // The recently-closed strip issues its own query (triageStates:
  // ['resolved', 'dismissed'], see use-inbox-recently-closed.ts), separate
  // from the open-feedback query the live queue uses — distinguish them by
  // the `triage` filter param so only the recently-closed one returns data.
  await page.route("**/backend/api/v1/quality/turns**", async (route) => {
    const url = new URL(route.request().url());
    // normalizeQualityTurnsRequest sorts the triage-state set alphabetically
    // (lib/quality-query-state.ts), so ['resolved', 'dismissed'] is sent as
    // "dismissed,resolved" on the wire.
    const isRecentlyClosedQuery = url.searchParams.get("triage") === "dismissed,resolved";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: isRecentlyClosedQuery ? [dismissedTurn] : [],
        total: isRecentlyClosedQuery ? 1 : 0,
        page: 1,
        pageSize: isRecentlyClosedQuery ? 10 : 25,
        totalPages: 1,
      }),
    });
  });

  await page.goto(`/w/${workspaceKey}/activity?tab=needs-attention`);

  const queue = page.getByLabel("Inbox queue");
  await expect(queue.getByText("Recently closed")).toBeVisible();
  await expect(queue.getByText("Do you ship internationally?")).toBeVisible();
  // The resolution label alone used to be all this row showed — the fix
  // appends when it closed, using the same absolute-timestamp formatter the
  // All lens's rows use (formatInboxRowTimestamp). The exact rendered string
  // is locale-dependent, so this checks the fix's shape (a separator
  // followed by non-empty content) rather than an exact date string.
  await expect(queue.getByText(/^Dismissed · .+/)).toBeVisible();
  await expect(queue.getByText("Dismissed", { exact: true })).toHaveCount(0);
});

// ── Per-teammate ownership ──────────────────────────────────────────────────

const teammates = [
  { userId: currentUserId, label: "Test Operator" },
  { userId: "user-dana", label: "Dana Scully" },
  { userId: "user-fox", label: "fox@example.com" },
];

const handoffOwnership = (conversationId: string, owner: { userId: string; label: string } | null, version: number) => ({
  conversationId,
  workspaceId,
  state: "human_owned" as const,
  ownerAccountId: owner ? accountId : null,
  ownerUserId: owner?.userId ?? null,
  ownerDisplayName: owner?.label ?? null,
  reason: "visitor asked for a person",
  version,
  takenOverAt: owner ? nowIso : null,
  createdAt: nowIso,
  updatedAt: nowIso,
});

type HandoffOwnershipFixture = ReturnType<typeof handoffOwnership>;

const handoffSummary = (id: string, preview: string, ownership: HandoffOwnershipFixture) => ({
  id,
  agentId: defaultAgentId,
  agentName: "Gioia",
  sourceChannel: "authenticated_chat",
  sourceOrigin: null,
  anonymousSessionId: null,
  createdAt: nowIso,
  updatedAt: nowIso,
  messageCount: 1,
  userMessageCount: 1,
  assistantMessageCount: 0,
  preview,
  ownership,
});

const handoffDetail = (id: string, ownership: HandoffOwnershipFixture) => ({
  conversationId: id,
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
  ownership,
  messages: [
    { id: `${id}-message`, role: "user" as const, source: "customer" as const, content: "Can I speak to someone?", createdAt: nowIso },
  ],
});

const stubEmptyQualityQueue = async (page: import("@playwright/test").Page) => {
  await page.route("**/backend/api/v1/quality/turns**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [], total: 0, page: 1, pageSize: 25, totalPages: 1 }),
    });
  });
};

test("operator assigns a waiting handoff to a teammate, who then holds it", async ({ page }) => {
  const conversationId = "conversation-hand-to";
  const waiting = handoffOwnership(conversationId, null, 1);
  const transferRequests: Array<{ toUserId: string; expectedVersion: number }> = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    historyList: { conversations: [handoffSummary(conversationId, "Refund for a cancelled class", waiting)], total: 1, nextCursor: null, hasMore: false },
    conversationDetails: { [conversationId]: handoffDetail(conversationId, waiting) },
    conversationOperators: teammates,
    transferRequests,
  });
  await stubEmptyQualityQueue(page);

  await page.goto(`/w/${workspaceKey}/activity`);
  await page.getByLabel("Inbox queue").getByRole("button", { name: /Refund for a cancelled class/ }).click();

  const response = page.getByLabel("Response", { exact: true });
  await response.getByRole("textbox", { name: "Reply to the visitor" }).fill("Draft for Dana");
  await response.getByRole("button", { name: "Assign", exact: true }).click();
  await page.getByRole("menuitem", { name: "Dana Scully" }).click();

  await expect.poll(() => transferRequests).toEqual([{ toUserId: "user-dana", expectedVersion: 1 }]);
  await expect(response.getByText("Dana Scully is handling this")).toBeVisible();
  await expect(response.getByRole("textbox", { name: "Reply to the visitor" })).toHaveCount(0);
  await expect(response.getByRole("button", { name: "Reassign" })).toBeVisible();
});

test("operator assigns a waiting handoff to themselves and keeps the composer", async ({ page }) => {
  const conversationId = "conversation-assign-me";
  const waiting = handoffOwnership(conversationId, null, 1);
  const transferRequests: Array<{ toUserId: string; expectedVersion: number }> = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    historyList: { conversations: [handoffSummary(conversationId, "Lost parcel", waiting)], total: 1, nextCursor: null, hasMore: false },
    conversationDetails: { [conversationId]: handoffDetail(conversationId, waiting) },
    conversationOperators: teammates,
    transferRequests,
  });
  await stubEmptyQualityQueue(page);

  await page.goto(`/w/${workspaceKey}/activity`);
  await page.getByLabel("Inbox queue").getByRole("button", { name: /Lost parcel/ }).click();

  const response = page.getByLabel("Response", { exact: true });
  const replyBox = response.getByRole("textbox", { name: "Reply to the visitor" });
  await replyBox.fill("Draft I keep");
  await response.getByRole("button", { name: "Assign", exact: true }).click();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem")).toHaveText(["Me", "Dana Scully", "fox@example.com"]);
  await menu.getByRole("menuitem", { name: "Me" }).click();

  await expect.poll(() => transferRequests).toEqual([{ toUserId: currentUserId, expectedVersion: 1 }]);
  await expect(response.getByRole("button", { name: "Reassign" })).toBeVisible();
  await expect(replyBox).toHaveValue("Draft I keep");
});

test("handing to a teammate who can no longer take it keeps the draft and re-reads the teammates", async ({ page }) => {
  const conversationId = "conversation-hand-to-gone";
  const waiting = handoffOwnership(conversationId, null, 1);
  const requestLog: string[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    historyList: { conversations: [handoffSummary(conversationId, "Billing question", waiting)], total: 1, nextCursor: null, hasMore: false },
    conversationDetails: { [conversationId]: handoffDetail(conversationId, waiting) },
    conversationOperators: [...teammates, { userId: "user-skinner", label: "Walter Skinner" }],
    ineligibleTransferTargets: ["user-skinner"],
    requestLog,
  });
  await stubEmptyQualityQueue(page);

  await page.goto(`/w/${workspaceKey}/activity`);
  await page.getByLabel("Inbox queue").getByRole("button", { name: /Billing question/ }).click();

  const response = page.getByLabel("Response", { exact: true });
  const replyBox = response.getByRole("textbox", { name: "Reply to the visitor" });
  const teammateReads = () => requestLog.filter((entry) => entry === "GET /conversations/operators").length;
  await replyBox.fill("Draft that must survive");
  await response.getByRole("button", { name: "Assign", exact: true }).click();
  const readsBeforeHandOff = teammateReads();
  await page.getByRole("menuitem", { name: "Walter Skinner" }).click();

  await expect(response.getByRole("status")).toBeVisible();
  await expect(replyBox).toHaveValue("Draft that must survive");
  await expect.poll(teammateReads).toBeGreaterThan(readsBeforeHandOff);
});

test("operator reassigns a handoff a teammate holds to themselves and gets the composer back", async ({ page }) => {
  const conversationId = "conversation-take-over";
  const heldByDana = handoffOwnership(conversationId, teammates[1], 4);
  const transferRequests: Array<{ toUserId: string; expectedVersion: number }> = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    historyList: { conversations: [handoffSummary(conversationId, "Invoice address change", heldByDana)], total: 1, nextCursor: null, hasMore: false },
    conversationDetails: { [conversationId]: handoffDetail(conversationId, heldByDana) },
    conversationOperators: teammates,
    transferRequests,
  });
  await stubEmptyQualityQueue(page);

  await page.goto(`/w/${workspaceKey}/activity`);
  await page.getByLabel("Inbox queue").getByRole("button", { name: /Invoice address change/ }).click();

  const response = page.getByLabel("Response", { exact: true });
  await expect(response.getByText("Dana Scully is handling this")).toBeVisible();
  await expect(response.getByRole("textbox", { name: "Reply to the visitor" })).toHaveCount(0);

  await response.getByRole("button", { name: "Reassign" }).click();
  // Me first, then everyone else but Dana, who holds it.
  await expect(page.getByRole("menu").getByRole("menuitem")).toHaveText(["Me", "fox@example.com"]);
  await page.getByRole("menuitem", { name: "Me" }).click();

  await expect.poll(() => transferRequests).toEqual([{ toUserId: currentUserId, expectedVersion: 4 }]);
  await expect(response.getByRole("textbox", { name: "Reply to the visitor" })).toBeVisible();
  await expect(response.getByText("Dana Scully is handling this")).toHaveCount(0);
});

test("operator reassigns a handoff a teammate holds to a third teammate", async ({ page }) => {
  const conversationId = "conversation-reassign-third";
  const heldByDana = handoffOwnership(conversationId, teammates[1], 4);
  const transferRequests: Array<{ toUserId: string; expectedVersion: number }> = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    historyList: { conversations: [handoffSummary(conversationId, "Change of delivery date", heldByDana)], total: 1, nextCursor: null, hasMore: false },
    conversationDetails: { [conversationId]: handoffDetail(conversationId, heldByDana) },
    conversationOperators: teammates,
    transferRequests,
  });
  await stubEmptyQualityQueue(page);

  await page.goto(`/w/${workspaceKey}/activity`);
  await page.getByLabel("Inbox queue").getByRole("button", { name: /Change of delivery date/ }).click();

  const response = page.getByLabel("Response", { exact: true });
  await expect(response.getByText("Dana Scully is handling this")).toBeVisible();
  await response.getByRole("button", { name: "Reassign" }).click();
  await page.getByRole("menuitem", { name: "fox@example.com" }).click();

  await expect.poll(() => transferRequests).toEqual([{ toUserId: "user-fox", expectedVersion: 4 }]);
  await expect(response.getByText("fox@example.com is handling this")).toBeVisible();
  await expect(response.getByRole("textbox", { name: "Reply to the visitor" })).toHaveCount(0);
});

test("ownership taken over elsewhere reaches an open pane through the tail poll, and the composer switches away", async ({ page }) => {
  const conversationId = "conversation-tail-ownership";
  const waiting = handoffOwnership(conversationId, null, 1);
  const takenByDana = handoffOwnership(conversationId, teammates[1], 2);

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    historyList: { conversations: [handoffSummary(conversationId, "Order not received", waiting)], total: 1, nextCursor: null, hasMore: false },
    conversationDetails: { [conversationId]: handoffDetail(conversationId, waiting) },
    conversationOperators: teammates,
  });
  await stubEmptyQualityQueue(page);

  // The conversation-detail fetch is never re-read in this test (no reply, no
  // transfer, no hand-back from this operator) and keeps reporting the
  // unclaimed handoff throughout. Only the tail poll — read every second while
  // the pane is open — reports that Dana took it, standing in for a transfer
  // made from another tab or teammate while this pane stayed open.
  let tailCalls = 0;
  await page.route(`**/backend/api/v1/history/chat/${conversationId}/tail**`, async (route) => {
    tailCalls += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ messages: [], cursor: null, ownership: tailCalls === 1 ? waiting : takenByDana }),
    });
  });

  await page.goto(`/w/${workspaceKey}/activity`);
  await page.getByLabel("Inbox queue").getByRole("button", { name: /Order not received/ }).click();

  const response = page.getByLabel("Response", { exact: true });
  await expect(response.getByRole("textbox", { name: "Reply to the visitor" })).toBeVisible();

  await expect(response.getByText("Dana Scully is handling this")).toBeVisible();
  await expect(response.getByRole("textbox", { name: "Reply to the visitor" })).toHaveCount(0);
  await expect(response.getByRole("button", { name: "Reassign" })).toBeVisible();
});

// The record a hand-back leaves behind: AI-owned again, naming no teammate.
const handedBackOwnership = (conversationId: string, version: number) => ({
  ...handoffOwnership(conversationId, null, version),
  state: "ai_owned" as const,
  reason: null,
});

// The tail keeps reporting `held` until the returned callback runs, then the
// hand-back record — standing in for Done pressed in another tab, by a
// teammate, or from Slack while this pane stays open. The detail fetch is
// never re-read before then, so it keeps reporting `held` throughout.
const routeTailHandBack = async (
  page: import("@playwright/test").Page,
  conversationId: string,
  held: HandoffOwnershipFixture,
  handedBack: ReturnType<typeof handedBackOwnership>,
) => {
  let handedBackElsewhere = false;
  await page.route(`**/backend/api/v1/history/chat/${conversationId}/tail**`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ messages: [], cursor: null, ownership: handedBackElsewhere ? handedBack : held }),
    });
  });
  return () => {
    handedBackElsewhere = true;
  };
};

test("a hand-back made elsewhere reaches an open pane on my conversation through the tail poll, and sending claims it again", async ({ page }) => {
  const conversationId = "conversation-tail-hand-back-mine";
  const heldByMe = handoffOwnership(conversationId, teammates[0], 2);
  const requestLog: string[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    historyList: { conversations: [handoffSummary(conversationId, "Gift card balance", heldByMe)], total: 1, nextCursor: null, hasMore: false },
    conversationDetails: { [conversationId]: handoffDetail(conversationId, heldByMe) },
    conversationOperators: teammates,
    requestLog,
  });
  await stubEmptyQualityQueue(page);
  const handBackElsewhere = await routeTailHandBack(page, conversationId, heldByMe, handedBackOwnership(conversationId, 3));

  await page.goto(`/w/${workspaceKey}/activity`);
  await page.getByLabel("Inbox queue").getByRole("button", { name: /Gift card balance/ }).click();

  const response = page.getByLabel("Response", { exact: true });
  const replyBox = response.getByRole("textbox", { name: "Reply to the visitor" });
  await expect(response.getByRole("button", { name: "Done" })).toBeVisible();
  await expect(response.getByRole("button", { name: "Reassign" })).toBeVisible();

  handBackElsewhere();

  // Nothing left to hand back or reassign: the agent holds it again.
  await expect(response.getByRole("button", { name: "Done" })).toHaveCount(0);
  await expect(response.getByRole("button", { name: "Reassign" })).toHaveCount(0);
  await expect(response.getByRole("button", { name: "Assign", exact: true })).toHaveCount(0);
  await expect(replyBox).toBeVisible();

  await replyBox.fill("I'm back on this one");
  await response.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => requestLog).toContainEqual(`POST /conversations/${conversationId}/takeover`);
});

test("a hand-back made elsewhere on a conversation a teammate held brings the claim-on-send composer back", async ({ page }) => {
  const conversationId = "conversation-tail-hand-back-teammate";
  const heldByDana = handoffOwnership(conversationId, teammates[1], 4);

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    historyList: { conversations: [handoffSummary(conversationId, "Missing voucher code", heldByDana)], total: 1, nextCursor: null, hasMore: false },
    conversationDetails: { [conversationId]: handoffDetail(conversationId, heldByDana) },
    conversationOperators: teammates,
  });
  await stubEmptyQualityQueue(page);
  const handBackElsewhere = await routeTailHandBack(page, conversationId, heldByDana, handedBackOwnership(conversationId, 5));

  await page.goto(`/w/${workspaceKey}/activity`);
  await page.getByLabel("Inbox queue").getByRole("button", { name: /Missing voucher code/ }).click();

  const response = page.getByLabel("Response", { exact: true });
  const replyBox = response.getByRole("textbox", { name: "Reply to the visitor" });
  await expect(response.getByText("Dana Scully is handling this")).toBeVisible();
  await expect(replyBox).toHaveCount(0);

  handBackElsewhere();

  await expect(replyBox).toBeVisible();
  await expect(replyBox).toHaveAttribute("placeholder", /sending takes over the conversation/);
  await expect(response.getByText("Dana Scully is handling this")).toHaveCount(0);
  await expect(response.getByRole("button", { name: "Reassign" })).toHaveCount(0);
  await expect(response.getByRole("button", { name: "Done" })).toHaveCount(0);
});

test("the Taken by: Me filter shows only the signed-in teammate's handoffs, not the whole organisation's", async ({ page }) => {
  const mine = handoffOwnership("conversation-mine", teammates[0], 2);
  const danas = handoffOwnership("conversation-danas", teammates[1], 2);

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    historyList: {
      conversations: [
        handoffSummary("conversation-mine", "Mine to answer", mine),
        handoffSummary("conversation-danas", "Dana is on it", danas),
      ],
      total: 2,
      nextCursor: null,
      hasMore: false,
    },
  });
  await stubEmptyQualityQueue(page);

  await page.goto(`/w/${workspaceKey}/activity`);
  const queue = page.getByLabel("Inbox queue");
  await expect(queue.getByRole("button", { name: /Mine to answer/ })).toBeVisible();
  await expect(queue.getByRole("button", { name: /Dana is on it/ })).toBeVisible();

  await queue.getByLabel("Filter by taken by").click();
  await page.getByRole("option", { name: "Me", exact: true }).click();

  await expect(queue.getByRole("button", { name: /Mine to answer/ })).toBeVisible();
  await expect(queue.getByRole("button", { name: /Dana is on it/ })).toHaveCount(0);

  await queue.getByLabel("Filter by taken by").click();
  await page.getByRole("option", { name: "Dana Scully" }).click();

  await expect(queue.getByRole("button", { name: /Dana is on it/ })).toBeVisible();
  await expect(queue.getByRole("button", { name: /Mine to answer/ })).toHaveCount(0);
});

test("a feedback item on a conversation a teammate holds still offers Done", async ({ page }) => {
  const conversationId = "conversation-feedback-held";
  const assistantMessageId = "assistant-feedback-held";
  const heldByDana = handoffOwnership(conversationId, teammates[1], 3);
  const feedbackTurn = {
    assistantMessageId,
    conversationId,
    agentId: defaultAgentId,
    agentName: "Gioia",
    channel: "website_embed",
    question: "Is the studio open on holidays?",
    answerPreview: "The studio is open every day.",
    skillName: "retrieval.answer",
    skillOutcome: "grounded",
    skillStatus: "completed",
    totalLatencyMs: 900,
    createdAt: nowIso,
    feedback: {
      upCount: 0,
      downCount: 1,
      latestDownUpdatedAt: nowIso,
      comments: [{ value: "down", comment: "It is closed on holidays.", createdAt: nowIso, updatedAt: nowIso }],
    },
    triage: { state: "open", version: 0, resolution: null, legacyReason: null, closedAt: null, updatedAt: null },
    verification: null,
  };

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    conversationDetails: { [conversationId]: handoffDetail(conversationId, heldByDana) },
    conversationOperators: teammates,
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
    const body = route.request().postDataJSON() as { state: string; expectedVersion: number };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        state: body.state,
        version: body.expectedVersion + 1,
        resolution: null,
        legacyReason: null,
        closedAt: null,
        updatedAt: nowIso,
      }),
    });
  });

  await page.goto(`/w/${workspaceKey}/activity?tab=needs-attention`);
  await page.getByLabel("Inbox queue").getByRole("button", { name: /Is the studio open on holidays\?/ }).click();

  const response = page.getByLabel("Response", { exact: true });
  await expect(response.getByText("Dana Scully is handling this")).toBeVisible();
  await expect(response.getByRole("textbox", { name: "Reply to the visitor" })).toHaveCount(0);

  await response.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("heading", { name: "Resolve review" })).toBeVisible();
});
