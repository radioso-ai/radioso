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

  // Activity's views are nested sidebar items now, not in-page tabs.
  await sidebar.getByRole("link", { name: "Activity" }).click();
  await expect(sidebar.getByRole("link", { name: "Inbox" })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "Conversations" })).toBeVisible();

  // Audience Pulse and Quality are top-level rail items, not nested under Activity.
  await expect(sidebar.getByRole("link", { name: "Audience Pulse" })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "Quality", exact: true })).toBeVisible();
  // Eval no longer has its own top-level rail entry — it lives under Quality.
  await expect(sidebar.getByRole("link", { name: "Eval", exact: true })).toHaveCount(0);

  // Quality nests its own views (Review / Evals) when active.
  await sidebar.getByRole("link", { name: "Quality", exact: true }).click();
  await expect(sidebar.getByRole("link", { name: "Review" })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "Evals" })).toBeVisible();
});

test("Activity is promoted with a needs-attention badge reflecting the inbox count", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { pendingDecisions });

  await page.goto(`/w/${workspaceKey}/knowledge`);

  const sidebar = page.locator('[data-slot="sidebar-container"]');
  const links = sidebar.getByRole("link");
  // Activity is promoted to the first position, above Agents.
  await expect(links.nth(0)).toContainText("Activity");
  await expect(links.nth(1)).toContainText("Agents");

  await expect(sidebar.getByLabel("3 items need attention")).toHaveText("3");
});
