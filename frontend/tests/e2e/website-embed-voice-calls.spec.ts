import { expect, test } from "@playwright/test";

import {
  basePlatformSettings,
  defaultAgentId,
  installDashboardApiMocks,
  seedDashboardStorage,
  workspaceKey,
} from "./dashboard-fixtures";

// The website widget's "Offer calls on the website" switch: the operator's own choice, saved on the
// agent's website embed block. When the backend says voice is missing a piece that turning voice on
// sets up, the switch turns voice on first (asking for the vendor key in place); a publication or an
// unreadable stored key it cannot fix.

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

test("an operator with voice off and no key turns calls on: the key is asked for in place, and saving it sets voice up and offers calls", async ({ page }) => {
  const agentUpdates: unknown[] = [];
  const voiceChannelSwitches: boolean[] = [];
  const providerCredentialUpdates: Array<{ method: "PUT" | "DELETE"; provider: string; body?: unknown }> = [];
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    platformSettings: basePlatformSettings(),
    agentUpdates,
    voiceChannelSwitches,
    providerCredentialUpdates,
    voiceCallReadiness: { ready: false, missing: "voice_channel" },
  });
  await openWebChat(page);

  const offerCalls = page.getByRole("switch", { name: "Offer calls on the website" });
  await expect(offerCalls).toBeEnabled();
  await expect(offerCalls).not.toBeChecked();
  await expect(page.getByText("Turning it on sets up the agent’s voice on ElevenLabs.")).toBeVisible();

  // Cancelling the key leaves calls off.
  await offerCalls.click();
  const keyDialog = page.getByRole("dialog", { name: "ElevenLabs API key" });
  await expect(keyDialog).toContainText("Add your ElevenLabs API key.");
  await keyDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(offerCalls).not.toBeChecked();
  expect(agentUpdates).toEqual([]);

  await offerCalls.click();
  await keyDialog.getByLabel("API key").fill("sk_elevenlabs_example");
  await keyDialog.getByRole("button", { name: "Save key" }).click();

  await expect(keyDialog).toHaveCount(0);
  await expect(offerCalls).toBeChecked();
  expect(providerCredentialUpdates).toEqual([{ method: "PUT", provider: "elevenlabs", body: { apiKey: "sk_elevenlabs_example" } }]);
  // Turning voice on failed for want of a key, then went through once the key was stored.
  expect(voiceChannelSwitches).toEqual([true, true, true]);
  await expect.poll(() => agentUpdates.length).toBe(1);
  expect(agentUpdates).toEqual([{ surfaceSettings: { websiteEmbed: { voiceCallsOffered: true } } }]);

  await page.reload();
  await expect(page.getByRole("switch", { name: "Offer calls on the website" })).toBeChecked();
});

for (const [missing, hint] of [
  ["publication", "Publish the agent first: until it is published, it answers no chats or calls."],
  ["encryption", "Radioso cannot read the stored ElevenLabs key. Check CONNECTOR_ENCRYPTION_KEY; after a key rotation, list the key it replaced in CONNECTOR_ENCRYPTION_PREVIOUS_KEYS. Otherwise enter the key again."],
] as const) test(`a bound runtime whose ${missing} is missing says so, and the switch stays off`, async ({ page }) => {
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
  const readiness: { ready: boolean; missing: "publication" | null } = { ready: false, missing: "publication" };
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    platformSettings: basePlatformSettings(),
    agentSettingsOverrides: { voice: readyVoice },
    voiceCallReadiness: readiness,
  });
  await openWebChat(page);
  const offerCalls = page.getByRole("switch", { name: "Offer calls on the website" });
  await expect(offerCalls).toBeDisabled();

  // The operator publishes the agent in another tab and comes back.
  readiness.ready = true;
  readiness.missing = null;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));

  await expect(offerCalls).toBeEnabled();
  await expect(page.getByText("Visitors see Talk beside Send and can talk to the agent.")).toBeVisible();
});

test("switching voice and saving the Voice card each tell the page to read the agent's voice readiness again", async ({ page }) => {
  await page.addInitScript(() => {
    const heard: unknown[] = [];
    Object.assign(window, { __voiceSaved: heard });
    window.addEventListener("radioso:agent-voice-saved", (event) => heard.push((event as CustomEvent).detail));
  });
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings(), voiceConnection: { vendorKey: "stored" } });
  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=channels&anchor=api-channel`);
  const card = page.locator("#voice-channel");
  const voiceSwitch = card.getByRole("switch", { name: "Voice channel" });
  await voiceSwitch.click();
  await expect(voiceSwitch).toBeChecked();
  await card.getByRole("switch", { name: "Switch language with the caller" }).click();
  await card.getByRole("button", { name: "Save voice settings" }).click();
  await expect(card.getByText("Saved", { exact: true })).toBeVisible();

  expect(await page.evaluate(() => (window as unknown as { __voiceSaved: unknown[] }).__voiceSaved)).toEqual([{ agentId: defaultAgentId }, { agentId: defaultAgentId }]);
});
