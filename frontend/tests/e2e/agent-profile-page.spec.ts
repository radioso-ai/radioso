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
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings() });
  // The name autosaves on its own; the agent list is then read again, by the sidebar's switcher
  // and by the agent view, so count the reads that follow the save.
  let nameSaved = false;
  let refreshReads = 0;
  page.on("request", (request) => {
    if (request.method() === "PUT" && new URL(request.url()).pathname === `/backend/api/v1/agents/${defaultAgentId}`) nameSaved = true;
  });
  page.on("response", (response) => {
    if (nameSaved && response.request().method() === "GET" && new URL(response.url()).pathname === "/backend/api/v1/agents") refreshReads += 1;
  });

  await page.goto(profileUrl);
  const instructions = page.locator("#assistantAnswerInstruction");
  await instructions.fill("Draft wording that is not saved yet.");
  await expect(page.getByText("Unsaved changes")).toBeVisible();

  await page.getByLabel("Assistant name").fill("Renamed Desk");

  await expect.poll(() => refreshReads).toBeGreaterThanOrEqual(2);
  await expect(page.getByRole("button", { name: "Renamed Desk", exact: true })).toBeVisible();

  // The refreshed list is in, and it must not have replaced the page: the unsaved draft is still on
  // screen and still unsaved.
  await expect(instructions).toHaveValue("Draft wording that is not saved yet.");
  await expect(page.getByText("Unsaved changes")).toBeVisible();
  await expect(page.getByLabel("Assistant name")).toHaveValue("Renamed Desk");
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
