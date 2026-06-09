import { expect, test } from "@playwright/test";

import { installDashboardApiMocks, seedDashboardStorage, workspaceKey } from "./dashboard-fixtures";

test("account usage page shows trends and reloads when controls change", async ({ page }) => {
  const requestLog: string[] = [];
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { requestLog });

  await page.goto(`/w/${workspaceKey}/usage`);

  const usageTrends = page.getByTestId("usage-trends");
  await expect(usageTrends.getByText("Usage trends")).toBeVisible();
  await expect(usageTrends.getByText("Conversations", { exact: true })).toBeVisible();
  await expect(usageTrends.getByText("Messages", { exact: true })).toBeVisible();
  await expect(usageTrends.getByText("Tokens", { exact: true })).toBeVisible();
  await expect(usageTrends.getByText("600")).toBeVisible();

  // Radix Select can race a React re-render and close the popover before the
  // option is clicked, which is intermittent under parallel-suite load. Retry
  // the open+select as one unit so a closed popover is simply reopened.
  await expect(async () => {
    await page.getByLabel("Granularity").click();
    await page.getByRole("option", { name: "Weekly" }).click({ timeout: 2000 });
  }).toPass({ timeout: 20000 });

  await expect
    .poll(() => requestLog.some((entry) => entry.includes("/account/usage-trends") && entry.includes("granularity=week")), { timeout: 15000 })
    .toBe(true);

  await page.getByRole("button", { name: /refresh/i }).click();
  await expect
    .poll(() => requestLog.filter((entry) => entry.startsWith("GET /account/usage-trends")).length, { timeout: 15000 })
    .toBeGreaterThan(1);
});
