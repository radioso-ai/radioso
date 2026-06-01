import { expect, test } from "@playwright/test";

import {
  installDashboardApiMocks,
  nowIso,
  seedDashboardStorage,
  workspaceKey,
} from "./dashboard-fixtures";

const manyDocuments = Array.from({ length: 60 }, (_, index) => ({
  id: `doc-${index + 1}`,
  title: `Course Guide ${index + 1}`,
  status: "processed",
  ragStatus: "processed",
  createdAt: nowIso,
  updatedAt: nowIso,
  metadata: {},
  sourceKind: "inline_text",
}));

test("dashboard page headers stay fixed while content panes scroll", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    documentList: {
      documents: manyDocuments,
      total: manyDocuments.length,
      nextCursor: null,
      hasMore: false,
    },
  });

  await page.goto(`/w/${workspaceKey}/knowledge`);

  const header = page.getByRole("heading", { name: "Documents", exact: true });
  const documentsTable = page.getByRole("table", { name: "Documents" });
  const contentPane = documentsTable.locator(
    'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " overflow-y-auto ")][1]',
  );
  await expect(header).toBeVisible();
  await expect(documentsTable).toBeVisible();
  await page.getByRole("button", { name: "Course Guide 1", exact: true }).click();
  await expect(page.getByRole("button", { name: "Back to documents" }).first()).toBeVisible();
  await page.getByRole("button", { name: "Back to documents" }).first().click();
  await expect(header).toBeVisible();

  const initialHeaderTop = await header.evaluate((element) => element.getBoundingClientRect().top);
  const initialWindowScrollY = await page.evaluate(() => window.scrollY);

  await contentPane.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });

  await expect
    .poll(() => contentPane.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await expect.poll(() => header.evaluate((element) => element.getBoundingClientRect().top)).toBe(initialHeaderTop);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(initialWindowScrollY);
});
