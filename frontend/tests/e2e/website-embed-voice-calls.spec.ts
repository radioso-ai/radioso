import { expect, test } from "@playwright/test";

import {
  basePlatformSettings,
  defaultAgentId,
  installDashboardApiMocks,
  seedDashboardStorage,
  workspaceKey,
} from "./dashboard-fixtures";

// The website widget's "Offer calls on the website" switch: the operator's own choice, which the
// dashboard lets them switch on only once the agent's voice is ready (on, a runtime bound, the
// vendor key stored), and which it saves on the agent's website embed block.

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
    storedProviderCredentials: ["elevenlabs"],
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

test("a bound runtime without the vendor key asks for the key", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    platformSettings: basePlatformSettings(),
    agentSettingsOverrides: { voice: readyVoice },
  });
  await openWebChat(page);

  await expect(page.getByRole("switch", { name: "Offer calls on the website" })).toBeDisabled();
  await expect(page.getByText("Store the ElevenLabs key under Settings → Providers first.")).toBeVisible();
});
