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
