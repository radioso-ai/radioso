import { expect, test } from "@playwright/test";

import {
  basePlatformSettings,
  defaultAgentId,
  installDashboardApiMocks,
  seedDashboardStorage,
  workspaceKey,
} from "./dashboard-fixtures";

const profileUrl = `/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-profile`;

test("name, instructions, model and answer settings share one Profile page", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings() });

  await page.goto(profileUrl);

  await expect(page.getByRole("heading", { name: "Profile", level: 1, exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Name", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Instructions", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Answers", exact: true })).toBeVisible();

  await expect(page.getByLabel("Assistant name")).toBeVisible();
  await expect(page.locator("#agentInternalName")).toBeVisible();
  await expect(page.locator("#assistantAnswerInstruction")).toBeVisible();
  await expect(page.locator("#citationDisplayEnabled")).toBeVisible();
  await expect(page.locator("#assistantLinkUtmEnabled")).toBeVisible();
  await expect(page.locator("#proactiveGreetingEnabled")).toBeVisible();
});

test("renaming the agent keeps an unsaved Profile draft while the agent switcher refreshes", async ({ page }) => {
  await seedDashboardStorage(page);
  const requestLog: string[] = [];
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings(), requestLog });

  await page.goto(profileUrl);
  const instructions = page.locator("#assistantAnswerInstruction");
  await instructions.fill("Draft wording that is not saved yet.");
  await expect(page.getByText("Unsaved changes")).toBeVisible();

  await page.getByLabel("Assistant name").fill("Renamed Desk");

  // The name autosaves on its own; the agent list is then read again for the switcher's label.
  const nameSave = `PUT /agents/${defaultAgentId}`;
  await expect.poll(() => requestLog.includes(nameSave)).toBe(true);
  const savedAt = requestLog.lastIndexOf(nameSave);
  await expect.poll(() => requestLog.slice(savedAt + 1).includes("GET /agents")).toBe(true);

  // The refresh must not replace the page: the unsaved draft is still on screen and still unsaved.
  await expect(instructions).toHaveValue("Draft wording that is not saved yet.");
  await expect(page.getByText("Unsaved changes")).toBeVisible();
  await expect(page.getByLabel("Assistant name")).toHaveValue("Renamed Desk");
});

test("a change to the agent list elsewhere keeps an unsaved Profile draft on screen", async ({ page }) => {
  await seedDashboardStorage(page);
  const requestLog: string[] = [];
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings(), requestLog });

  await page.goto(profileUrl);
  const instructions = page.locator("#assistantAnswerInstruction");
  await instructions.fill("Draft wording that is not saved yet.");
  await expect(page.getByText("Unsaved changes")).toBeVisible();

  // The sidebar announces a created or deleted agent this way.
  const loggedBefore = requestLog.length;
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("radioso:agents-updated")));
  await expect.poll(() => requestLog.slice(loggedBefore).includes("GET /agents")).toBe(true);

  await expect(instructions).toHaveValue("Draft wording that is not saved yet.");
  await expect(page.getByText("Unsaved changes")).toBeVisible();
});

test("the retired identity and behavior anchors still land on Profile", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings() });

  for (const anchor of ["assistant-identity", "assistant-behavior"]) {
    await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=${anchor}`);

    await expect(page.getByRole("heading", { name: "Profile", level: 1, exact: true })).toBeVisible();
    await expect(page.getByLabel("Assistant name")).toBeVisible();
    await expect(page.locator("#assistantAnswerInstruction")).toBeVisible();
  }
});
