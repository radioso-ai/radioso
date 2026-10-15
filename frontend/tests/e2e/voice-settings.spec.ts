import { expect, test } from "@playwright/test";

import { defaultAgentId, installDashboardApiMocks, seedDashboardStorage, workspaceKey } from "./dashboard-fixtures";

const BRIDGE_LINE = "Let me check that for you, it only takes a moment.";
const GREETING = "Hi! How can I help you today?";

test("an operator turns voice on, writes an English bridge line and greeting, and finds both after a reload", async ({ page }) => {
  const agentUpdates: unknown[] = [];
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { agentUpdates });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=channels&anchor=api-channel`);

  const card = page.locator("#voice-channel");
  await expect(card.getByRole("heading", { name: "Voice", exact: true, level: 3 })).toBeVisible();
  const voiceSwitch = card.getByRole("switch", { name: "Voice lines on calls" });
  await expect(voiceSwitch).not.toBeChecked();
  await voiceSwitch.click();

  await card.getByLabel("Add a language").fill("English");
  await card.getByRole("button", { name: "Add", exact: true }).click();
  const english = card.getByRole("group", { name: "Voice lines: English" });
  await english.getByRole("button", { name: "Add check line" }).click();
  await english.getByRole("textbox", { name: "Check line 1" }).fill(BRIDGE_LINE);
  await english.getByRole("button", { name: "Add greeting line" }).click();
  await english.getByRole("textbox", { name: "Greeting line 1" }).fill(GREETING);

  await card.getByRole("button", { name: "Save voice settings" }).click();
  await expect(card.getByText("Saved", { exact: true })).toBeVisible();

  // One update carries both blocks whole, and nothing else.
  expect(agentUpdates).toEqual([{
    voice: { enabled: true, bridgeLines: { en: { acknowledge: [], check: [BRIDGE_LINE] } }, fallbackLine: {} },
    mechanicsReplies: { en: { greeting: [GREETING], thanks: [], farewell: [], acknowledgement: [] } },
  }]);

  await page.reload();

  const reloaded = page.locator("#voice-channel");
  await expect(reloaded.getByRole("switch", { name: "Voice lines on calls" })).toBeChecked();
  const reloadedEnglish = reloaded.getByRole("group", { name: "Voice lines: English" });
  await expect(reloadedEnglish.getByRole("textbox", { name: "Check line 1" })).toHaveValue(BRIDGE_LINE);
  await expect(reloadedEnglish.getByRole("textbox", { name: "Greeting line 1" })).toHaveValue(GREETING);
});
