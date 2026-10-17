import { expect, test, type Page } from "@playwright/test";

import { defaultAgentId, installDashboardApiMocks, seedDashboardStorage, workspaceKey } from "./dashboard-fixtures";

const BRIDGE_LINE = "Let me check that for you, it only takes a moment.";
const SECOND_BRIDGE_LINE = "One moment please while I look that up in our documents.";
const SHORT_ACKNOWLEDGEMENT = "Got it.";
const ITALIAN_BRIDGE_LINE = "Controllo subito per te, ci vorrà solo un momento.";
const FALLBACK_LINE = "Sorry, this is taking much longer than it should, could you ask me again?";
const RECORDING_NOTICE = "This call is recorded so the team can review it.";
const GREETING = "Hi! How can I help you today?";
const VENDOR_AGENT_ID = "agent_01jxk2v9qbe8n7r6t5w4";
const noReplies = { thanks: [], farewell: [], acknowledgement: [] };

const openVoiceCard = async (page: Page, agentId = defaultAgentId) => {
  await page.goto(`/w/${workspaceKey}/agents/${agentId}?tab=channels&anchor=api-channel`);
  const card = page.locator("#voice-channel");
  await expect(card.getByRole("heading", { name: "Voice", exact: true, level: 3 })).toBeVisible();
  return card;
};

const addLanguage = async (card: ReturnType<Page["locator"]>, language: string) => {
  const field = card.getByLabel("Add a language");
  await field.fill(language);
  await field.press("Enter");
  await field.press("Escape");
  const group = card.getByRole("group", { name: `Voice lines: ${language}` });
  await expect(group).toBeVisible();
  return group;
};

const save = async (card: ReturnType<Page["locator"]>) => {
  await card.getByRole("button", { name: "Save voice settings" }).click();
  await expect(card.getByText("Saved", { exact: true })).toBeVisible();
};

test("an operator binds the ElevenLabs agent, writes voice lines in two languages, trims them back, and finds the result after a reload", async ({ page }) => {
  const agentUpdates: unknown[] = [];
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { agentUpdates });

  const card = await openVoiceCard(page);
  const voiceSwitch = card.getByRole("switch", { name: "Voice channel" });
  await expect(voiceSwitch).not.toBeChecked();
  await voiceSwitch.click();
  await expect(card.getByLabel("Voice runtime")).toContainText("ElevenLabs");
  await card.getByLabel("ElevenLabs agent id").fill(`  ${VENDOR_AGENT_ID}  `);
  await card.getByLabel("Data residency").click();
  await page.getByRole("option", { name: "European Union" }).click();

  const english = await addLanguage(card, "English");
  await english.getByRole("button", { name: "Add check line" }).click();
  await english.getByRole("textbox", { name: "Check line 1" }).fill(BRIDGE_LINE);
  await english.getByRole("button", { name: "Add check line" }).click();
  await english.getByRole("textbox", { name: "Check line 2" }).fill(SECOND_BRIDGE_LINE);
  await english.getByRole("button", { name: "Add acknowledge line" }).click();
  await english.getByRole("textbox", { name: "Acknowledge line 1" }).fill(SHORT_ACKNOWLEDGEMENT);
  // A short line only warns: other dialects have no floor, so it still saves.
  await expect(english.getByText("Shorter than 45 characters: ElevenLabs will not speak it before the answer.")).toBeVisible();
  await english.getByRole("button", { name: "Add greeting line" }).click();
  await english.getByRole("textbox", { name: "Greeting line 1" }).fill(GREETING);
  const italian = await addLanguage(card, "Italian");
  await italian.getByRole("button", { name: "Add check line" }).click();
  await italian.getByRole("textbox", { name: "Check line 1" }).fill(ITALIAN_BRIDGE_LINE);
  const german = await addLanguage(card, "German");

  await save(card);
  // A language with nothing in it is not stored, and stays on the card until it is removed.
  await expect(german).toBeVisible();

  await english.getByRole("button", { name: "Remove check line 2" }).click();
  await english.getByRole("button", { name: "Remove acknowledge line 1" }).click();
  await english.getByLabel("Fallback line").fill(FALLBACK_LINE);
  await english.getByLabel("Recording notice").fill(RECORDING_NOTICE);
  await italian.getByRole("button", { name: "Remove language" }).click();
  await german.getByRole("button", { name: "Remove language" }).click();
  await save(card);

  expect(agentUpdates).toEqual([
    {
      voice: {
        enabled: true,
        bridgeLines: {
          en: { acknowledge: [SHORT_ACKNOWLEDGEMENT], check: [BRIDGE_LINE, SECOND_BRIDGE_LINE] },
          it: { acknowledge: [], check: [ITALIAN_BRIDGE_LINE] },
        },
        fallbackLine: {},
        runtime: { vendor: "elevenlabs", agentId: VENDOR_AGENT_ID, region: "eu" },
      },
      mechanicsReplies: { en: { greeting: [GREETING], ...noReplies } },
    },
    {
      voice: {
        enabled: true,
        bridgeLines: { en: { acknowledge: [], check: [BRIDGE_LINE] } },
        fallbackLine: { en: FALLBACK_LINE },
        runtime: { vendor: "elevenlabs", agentId: VENDOR_AGENT_ID, region: "eu" },
        recordingNotice: { en: RECORDING_NOTICE },
      },
      mechanicsReplies: { en: { greeting: [GREETING], ...noReplies } },
    },
  ]);

  await page.reload();

  const reloaded = page.locator("#voice-channel");
  await expect(reloaded.getByRole("switch", { name: "Voice channel" })).toBeChecked();
  await expect(reloaded.getByLabel("ElevenLabs agent id")).toHaveValue(VENDOR_AGENT_ID);
  await expect(reloaded.getByLabel("Data residency")).toContainText("European Union");
  const reloadedEnglish = reloaded.getByRole("group", { name: "Voice lines: English" });
  await expect(reloadedEnglish.getByRole("textbox", { name: "Check line 1" })).toHaveValue(BRIDGE_LINE);
  await expect(reloadedEnglish.getByRole("textbox", { name: "Check line 2" })).toHaveCount(0);
  await expect(reloadedEnglish.getByRole("textbox", { name: "Acknowledge line 1" })).toHaveCount(0);
  await expect(reloadedEnglish.getByLabel("Fallback line")).toHaveValue(FALLBACK_LINE);
  await expect(reloadedEnglish.getByLabel("Recording notice")).toHaveValue(RECORDING_NOTICE);
  await expect(reloadedEnglish.getByRole("textbox", { name: "Greeting line 1" })).toHaveValue(GREETING);
  await expect(reloaded.getByRole("group", { name: /^Voice lines: / })).toHaveCount(1);
});

test("an operator unbinds the ElevenLabs agent, clears the voice lines, then the quick replies, and each clear is sent as an empty block", async ({ page }) => {
  const agentUpdates: unknown[] = [];
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    agentUpdates,
    agentSettingsOverrides: {
      voice: {
        enabled: true,
        bridgeLines: { en: { acknowledge: [], check: [BRIDGE_LINE] } },
        fallbackLine: { en: FALLBACK_LINE },
        runtime: { vendor: "elevenlabs", agentId: VENDOR_AGENT_ID, region: "eu" },
      },
      mechanicsReplies: { en: { greeting: [GREETING], ...noReplies } },
    },
  });

  const card = await openVoiceCard(page);
  await expect(card.getByLabel("ElevenLabs agent id")).toHaveValue(VENDOR_AGENT_ID);
  await card.getByLabel("ElevenLabs agent id").fill("");
  const english = card.getByRole("group", { name: "Voice lines: English" });
  await card.getByRole("switch", { name: "Voice channel" }).click();
  await english.getByRole("button", { name: "Remove check line 1" }).click();
  await english.getByLabel("Fallback line").fill("");
  await save(card);

  await page.reload();
  const afterVoiceClear = page.locator("#voice-channel");
  await expect(afterVoiceClear.getByRole("switch", { name: "Voice channel" })).not.toBeChecked();
  // The quick replies the operator left alone are still there.
  const reloadedEnglish = afterVoiceClear.getByRole("group", { name: "Voice lines: English" });
  await expect(reloadedEnglish.getByRole("textbox", { name: "Greeting line 1" })).toHaveValue(GREETING);
  await expect(reloadedEnglish.getByRole("textbox", { name: "Check line 1" })).toHaveCount(0);

  // Adding a language that is already there is refused until that language is removed.
  const addLanguageField = afterVoiceClear.getByLabel("Add a language");
  await addLanguageField.fill("English");
  await addLanguageField.press("Enter");
  await addLanguageField.press("Escape");
  const duplicate = afterVoiceClear.getByText("That language is already added.");
  await expect(duplicate).toBeVisible();
  await reloadedEnglish.getByRole("button", { name: "Remove language" }).click();
  await expect(duplicate).toHaveCount(0);
  await save(afterVoiceClear);

  // Each save carries both blocks whole and nothing else, so every other agent setting stays as stored.
  expect(agentUpdates).toEqual([
    { voice: { enabled: false, bridgeLines: {}, fallbackLine: {}, runtime: null }, mechanicsReplies: { en: { greeting: [GREETING], ...noReplies } } },
    { voice: { enabled: false, bridgeLines: {}, fallbackLine: {}, runtime: null }, mechanicsReplies: {} },
  ]);

  await page.reload();
  await expect(page.locator("#voice-channel").getByRole("switch", { name: "Voice channel" })).toBeVisible();
  await expect(page.locator("#voice-channel").getByRole("group", { name: /^Voice lines: / })).toHaveCount(0);
});

test("switching to another agent shows that agent's own lines before its voice settings can be saved", async ({ page }) => {
  const otherAgentId = "77bcb0c8-caad-4a1b-9fef-70cbca3f7d12";
  const otherBridgeLine = "Give me a moment while I check our sales catalogue for you.";
  let releaseOtherAgent = () => {};
  const otherAgentRead = new Promise<void>((resolve) => { releaseOtherAgent = resolve; });
  const agentUpdates: unknown[] = [];
  const otherAgentUpdates: unknown[] = [];
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    agentUpdates,
    agentSettingsOverrides: {
      internalName: "support-desk",
      voice: { enabled: true, bridgeLines: { en: { acknowledge: [], check: [BRIDGE_LINE] } }, fallbackLine: {}, runtime: null },
    },
    extraAgents: [{
      settings: {
        id: otherAgentId,
        name: "Sales",
        internalName: "sales-desk",
        voice: { enabled: false, bridgeLines: { en: { acknowledge: [], check: [otherBridgeLine] } }, fallbackLine: {}, runtime: null },
        mechanicsReplies: {},
      },
      readGate: otherAgentRead,
      updates: otherAgentUpdates,
    }],
  });

  const card = await openVoiceCard(page);
  await expect(card.getByRole("textbox", { name: "Check line 1" })).toHaveValue(BRIDGE_LINE);

  await page.locator('[data-sidebar="sidebar"]').getByRole("link", { name: "sales-desk" }).click();
  await expect(page).toHaveURL(new RegExp(otherAgentId));
  // While the other agent loads, nothing of the first agent's lines can be saved over it.
  await expect(page.getByRole("button", { name: "Save voice settings" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Check line 1" })).toHaveCount(0);

  releaseOtherAgent();
  const otherCard = page.locator("#voice-channel");
  await expect(otherCard.getByRole("textbox", { name: "Check line 1" })).toHaveValue(otherBridgeLine);
  await expect(otherCard.getByRole("switch", { name: "Voice channel" })).not.toBeChecked();
  await save(otherCard);

  expect(otherAgentUpdates).toEqual([{
    voice: { enabled: false, bridgeLines: { en: { acknowledge: [], check: [otherBridgeLine] } }, fallbackLine: {}, runtime: null },
    mechanicsReplies: {},
  }]);
  expect(agentUpdates).toEqual([]);
});
