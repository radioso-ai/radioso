import { expect, test } from "@playwright/test";

import {
  defaultAgentId,
  installDashboardApiMocks,
  seedDashboardStorage,
  workspaceKey,
} from "./dashboard-fixtures";

// A branch is decided either by an exact rule or by the AI's judgment. The two used to
// look the same in the prose. This proves each branch line carries a visible, distinct
// decision marker, derived from its chips (not from the words).
test("branch lines show whether a rule or the AI decides them", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {});

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-routines`);
  await expect(page.getByRole("heading", { name: "Routines", level: 1 })).toBeVisible();

  await page.getByRole("button", { name: "Write in prose" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Eligibility");
  await page.getByLabel("Trigger", { exact: true }).fill("When a customer asks about an order");

  const editor = page.getByRole("textbox", { name: "Routine", exact: true });
  await editor.click();
  await editor.pressSequentially("Ask for @total");
  await page.getByRole("option", { name: /Create variable/ }).click();

  // A rule branch: a decided-in-code comparison, then an end target on the same line.
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Condition" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Variable").selectOption("total");
  await dialog.getByLabel("Type").selectOption("number");
  await dialog.getByLabel("Check").selectOption("gte");
  await dialog.getByLabel("Value").fill("100");
  await dialog.getByRole("button", { name: "Add check" }).click();
  await page.getByRole("button", { name: "End", exact: true }).click();

  // An AI branch: a plain-language condition, then an end target.
  await page.keyboard.press("Enter");
  await editor.pressSequentially("if they seem unsure ");
  await page.getByRole("button", { name: "End", exact: true }).click();

  // Each kind of branch is tagged distinctly; neither is invisible prose.
  await expect(page.locator('[data-routine-branch="rule"]')).toHaveCount(1);
  await expect(page.locator('[data-routine-branch="ai"]')).toHaveCount(1);

  // The decision is shown to the author as a readable badge, not just an attribute.
  const ruleBadge = await page
    .locator('[data-routine-branch="rule"]')
    .evaluate((element) => getComputedStyle(element, "::before").content);
  expect(ruleBadge).toContain("Rule");
  const aiBadge = await page
    .locator('[data-routine-branch="ai"]')
    .evaluate((element) => getComputedStyle(element, "::before").content);
  expect(aiBadge).toContain("AI decides");
});
