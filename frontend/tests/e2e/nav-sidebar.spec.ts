import { expect, test } from "@playwright/test";

import {
  defaultAgentId,
  installDashboardApiMocks,
  nowIso,
  seedDashboardStorage,
  workspaceKey,
} from "./dashboard-fixtures";

const pendingDecisions = [
  { agentId: defaultAgentId, handle: "decision-1", conversationId: "conv-1", reason: "Refund needs approval", createdAt: nowIso },
  { agentId: defaultAgentId, handle: "decision-2", conversationId: "conv-2", reason: "Escalation requested", createdAt: nowIso },
  { agentId: defaultAgentId, handle: "decision-3", conversationId: "conv-3", reason: "Policy exception", createdAt: nowIso },
] as never;

test("active section's sub-nav nests inline in the rail; other sections stay collapsed", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);

  const sidebar = page.locator('[data-slot="sidebar-container"]');

  await page.goto(`/w/${workspaceKey}/knowledge`);
  // Knowledge is active → its items are revealed nested under the rail row.
  await expect(sidebar.getByRole("link", { name: "Sources" })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "Ingestion" })).toBeVisible();

  // Switching sections collapses the previous section's items and reveals the new one's.
  await sidebar.getByRole("link", { name: "Agents" }).click();
  await expect(sidebar.getByRole("link", { name: "Ingestion" })).toHaveCount(0);
  await expect(sidebar.getByRole("link", { name: "Profile" })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "Skills" })).toBeVisible();

  // In the Agents section the agent picker replaces the "Agents" row (no redundant entry).
  await expect(sidebar.getByRole("button", { name: "Marta" })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "Agents" })).toHaveCount(0);

  // Inbox is a flat top-level rail item — no Activity section, no nested
  // sub-nav; the Needs-you/All split lives inside the page as a lens toggle.
  await expect(sidebar.getByRole("link", { name: "Inbox" })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "Activity" })).toHaveCount(0);
  await sidebar.getByRole("link", { name: "Inbox" }).click();
  await expect(sidebar.getByRole("link", { name: "Conversations" })).toHaveCount(0);

  // Audience Pulse and Quality are top-level rail items, not nested under Inbox.
  await expect(sidebar.getByRole("link", { name: "Audience Pulse" })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "Quality", exact: true })).toBeVisible();
  // Eval no longer has its own top-level rail entry — it lives under Quality.
  await expect(sidebar.getByRole("link", { name: "Eval", exact: true })).toHaveCount(0);

  // Quality nests its own views (Review / Evals) when active.
  await sidebar.getByRole("link", { name: "Quality", exact: true }).click();
  await expect(sidebar.getByRole("link", { name: "Review" })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "Evals" })).toBeVisible();
});

test("Inbox is promoted with a needs-attention badge reflecting the inbox count", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { pendingDecisions });

  await page.goto(`/w/${workspaceKey}/knowledge`);

  const sidebar = page.locator('[data-slot="sidebar-container"]');
  const links = sidebar.getByRole("link");
  // Inbox is promoted to the first position, above Agents.
  await expect(links.nth(0)).toContainText("Inbox");
  await expect(links.nth(1)).toContainText("Agents");

  await expect(sidebar.getByLabel("3 items need attention")).toHaveText("3");
});

test("the Inbox badge counts commented negative feedback too, matching the tab title and lens toggle count", async ({ page }) => {
  // A feedback-only workspace: zero pending decisions, zero human-owned
  // conversations, but one open commented-negative-feedback turn — an open
  // inbox item the badge previously ignored entirely (it only summed
  // decisions + human-owned conversations).
  const feedbackTurn = {
    assistantMessageId: "assistant-badge-feedback",
    conversationId: "conversation-badge-feedback",
    agentId: defaultAgentId,
    agentName: "Marta",
    channel: "website_embed",
    question: "Do you offer gift wrapping?",
    answerPreview: "We don't offer gift wrapping at checkout.",
    skillName: "retrieval.answer",
    skillOutcome: "grounded",
    skillStatus: "completed",
    totalLatencyMs: 700,
    createdAt: nowIso,
    feedback: {
      upCount: 0,
      downCount: 1,
      latestDownUpdatedAt: nowIso,
      comments: [{
        value: "down",
        comment: "Doesn't mention holiday wrapping options.",
        createdAt: nowIso,
        updatedAt: nowIso,
      }],
    },
    triage: { state: "open", version: 0, resolution: null, legacyReason: null, closedAt: null, updatedAt: null },
    verification: null,
  };

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);
  await page.route("**/backend/api/v1/quality/turns**", async (route) => {
    const url = new URL(route.request().url());
    const isCommentedFeedbackQuery =
      url.searchParams.get("feedback") === "down" && url.searchParams.get("hasComment") === "true";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: isCommentedFeedbackQuery ? [feedbackTurn] : [],
        total: isCommentedFeedbackQuery ? 1 : 0,
        page: 1,
        pageSize: isCommentedFeedbackQuery ? 25 : 1,
        totalPages: 1,
      }),
    });
  });

  await page.goto(`/w/${workspaceKey}/knowledge`);

  const sidebar = page.locator('[data-slot="sidebar-container"]');
  await expect(sidebar.getByLabel("1 items need attention")).toHaveText("1");
});
