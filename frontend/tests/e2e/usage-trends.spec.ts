import { expect, test } from "@playwright/test";

import { installDashboardApiMocks, seedDashboardStorage, workspaceKey } from "./dashboard-fixtures";

test("account usage page shows trends and reloads when controls change", async ({ page }) => {
  const requestLog: string[] = [];
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { requestLog });

  await page.goto(`/w/${workspaceKey}/usage`);

  const readyDocumentsCard = page.locator('[data-slot="card"]').filter({ hasText: "Ready documents" }).first();
  const chartCard = page.locator('[data-slot="card"]').filter({ hasText: "Usage by period" }).first();
  await expect(readyDocumentsCard).toBeVisible();
  await expect(chartCard).toBeVisible();
  const readyDocumentsBox = await readyDocumentsCard.boundingBox();
  const chartBox = await chartCard.boundingBox();
  expect(readyDocumentsBox).not.toBeNull();
  expect(chartBox).not.toBeNull();
  expect(readyDocumentsBox!.y).toBeLessThan(chartBox!.y);

  const usageTrends = page.getByTestId("usage-trends");
  await expect(usageTrends.getByText("Usage trends")).toBeVisible();
  await expect(usageTrends.getByText("Usage by period")).toBeVisible();
  await expect(usageTrends.getByTestId("usage-period-chart").getByRole("application")).toBeVisible();
  await expect(usageTrends.getByText("User messages")).toBeVisible();
  await expect(usageTrends.getByText("Assistant messages")).toBeVisible();
  await expect(usageTrends.getByText("Trend series")).toHaveCount(0);

  await usageTrends.getByRole("button", { name: "Tokens" }).click();
  await expect(usageTrends.getByText("Input tokens")).toBeVisible();
  await expect(usageTrends.getByText("Output tokens")).toBeVisible();

  await expect(async () => {
    await usageTrends.getByLabel("Granularity").click();
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
