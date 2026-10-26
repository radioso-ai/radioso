import { expect, test } from "@playwright/test";

import {
  basePlatformSettings,
  defaultAgentId,
  installDashboardApiMocks,
  seedDashboardStorage,
  workspaceKey,
} from "./dashboard-fixtures";

// The website widget's "Offer calls on the website" switch: the operator's own choice, which the
// dashboard lets them switch on only once the backend says the agent's voice is ready, and which
// it saves on the agent's website embed block.

const readyVoice = {
  enabled: true,
  bridgeLines: {},
  fallbackLine: {},
  runtime: { vendor: "elevenlabs" as const, agentId: "agent_42", region: "us" as const },
};

const openWebChat = async (page: import("@playwright/test").Page) => {
  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=channels&anchor=web-chat`);
  await expect(page.getByRole("heading", { name: "Website widget", exact: true })).toBeVisible();
};

test("an operator offers calls on the website once voice is ready, and the choice stays after a reload", async ({ page }) => {
  const agentUpdates: unknown[] = [];
  const platformSettings = basePlatformSettings();
  platformSettings.channels.websiteEmbedEnabled = true;
  platformSettings.channels.websiteEmbedAllowedOrigins = ["https://host.example"];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    platformSettings,
    agentUpdates,
    agentSettingsOverrides: { voice: readyVoice },
    voiceCallReadiness: { ready: true, missing: null },
  });
  await openWebChat(page);

  const offerCalls = page.getByRole("switch", { name: "Offer calls on the website" });
  await expect(offerCalls).toBeEnabled();
  await expect(offerCalls).not.toBeChecked();
  await expect(page.getByText("Visitors see Talk beside Send and can talk to the agent.")).toBeVisible();

  await offerCalls.click();

  await expect(offerCalls).toBeChecked();
  await expect.poll(() => agentUpdates.length).toBeGreaterThanOrEqual(1);
  expect(agentUpdates.at(-1)).toEqual({ surfaceSettings: { websiteEmbed: { voiceCallsOffered: true } } });

  await page.reload();
  await expect(page.getByRole("switch", { name: "Offer calls on the website" })).toBeChecked();
});

test("the switch stays off with one line naming what voice still needs", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings() });
  await openWebChat(page);

  const offerCalls = page.getByRole("switch", { name: "Offer calls on the website" });
  await expect(offerCalls).toBeDisabled();
  await expect(offerCalls).not.toBeChecked();
  await expect(page.getByText("Turn on the voice channel on the API page first.")).toBeVisible();
});

for (const [missing, hint] of [
  ["vendor_key", "Store the ElevenLabs key under Settings → Providers first."],
  ["encryption", "Radioso cannot read the stored ElevenLabs key. Check CONNECTOR_ENCRYPTION_KEY; after a key rotation, list the key it replaced in CONNECTOR_ENCRYPTION_PREVIOUS_KEYS. Otherwise enter the key again."],
] as const) test(`a bound runtime whose ${missing} is missing says so`, async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    platformSettings: basePlatformSettings(),
    agentSettingsOverrides: { voice: readyVoice },
    voiceCallReadiness: { ready: false, missing },
  });
  await openWebChat(page);

  await expect(page.getByRole("switch", { name: "Offer calls on the website" })).toBeDisabled();
  await expect(page.getByText(hint)).toBeVisible();
});

test("the switch reads readiness again when the window regains focus, after the missing piece was set up elsewhere", async ({ page }) => {
  const readiness: { ready: boolean; missing: "vendor_key" | null } = { ready: false, missing: "vendor_key" };
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    platformSettings: basePlatformSettings(),
    agentSettingsOverrides: { voice: readyVoice },
    voiceCallReadiness: readiness,
  });
  await openWebChat(page);
  const offerCalls = page.getByRole("switch", { name: "Offer calls on the website" });
  await expect(offerCalls).toBeDisabled();

  // The operator stores the ElevenLabs key under Settings → Providers in another tab and comes back.
  readiness.ready = true;
  readiness.missing = null;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));

  await expect(offerCalls).toBeEnabled();
  await expect(page.getByText("Visitors see Talk beside Send and can talk to the agent.")).toBeVisible();
});

test("saving the Voice card tells the page to read the agent's voice readiness again", async ({ page }) => {
  await page.addInitScript(() => {
    const heard: unknown[] = [];
    Object.assign(window, { __voiceSaved: heard });
    window.addEventListener("radioso:agent-voice-saved", (event) => heard.push((event as CustomEvent).detail));
  });
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings() });
  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=channels&anchor=api-channel`);
  const card = page.locator("#voice-channel");
  await card.getByRole("switch", { name: "Voice channel" }).click();
  await card.getByRole("button", { name: "Save voice settings" }).click();
  await expect(card.getByText("Saved", { exact: true })).toBeVisible();

  expect(await page.evaluate(() => (window as unknown as { __voiceSaved: unknown[] }).__voiceSaved)).toEqual([{ agentId: defaultAgentId }]);
});
