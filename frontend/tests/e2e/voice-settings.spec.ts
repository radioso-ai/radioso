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

test("an operator turns voice on, which connects ElevenLabs, writes voice lines in two languages, trims them back, and finds the result after a reload", async ({ page }) => {
  const agentUpdates: unknown[] = [];
  const voiceConnectionRequests: string[] = [];
  const voiceChannelSwitches: boolean[] = [];
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    agentUpdates,
    voiceConnectionRequests,
    voiceChannelSwitches,
    voiceConnection: { vendorKey: "stored", connectVendorAgentId: VENDOR_AGENT_ID, connectRegion: "eu" },
  });

  const card = await openVoiceCard(page);
  const voiceSwitch = card.getByRole("switch", { name: "Voice channel" });
  await expect(voiceSwitch).not.toBeChecked();
  await expect(card.getByRole("button", { name: /^Connect/ })).toHaveCount(0);
  await voiceSwitch.click();
  await expect(card.getByText("Connected to ElevenLabs · recordings stay in the European Union")).toBeVisible();
  await expect(voiceSwitch).toBeChecked();
  // The switch saved at once and connected on its own: no Connect, no save.
  expect(voiceChannelSwitches).toEqual([true]);
  expect(voiceConnectionRequests).toEqual([]);
  expect(agentUpdates).toEqual([]);

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
  // Every line is optional: a language with nothing in it is kept, and stays on the card until it is removed.
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
          de: { check: [], acknowledge: [] },
        },
        fallbackLine: {},
        runtime: { vendor: "elevenlabs", agentId: VENDOR_AGENT_ID, region: "eu" },
        languageSwitching: false,
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
        languageSwitching: false,
      },
      mechanicsReplies: { en: { greeting: [GREETING], ...noReplies } },
    },
  ]);

  await page.reload();

  const reloaded = page.locator("#voice-channel");
  await expect(reloaded.getByRole("switch", { name: "Voice channel" })).toBeChecked();
  await expect(reloaded.getByText("Connected to ElevenLabs · recordings stay in the European Union")).toBeVisible();
  const reloadedEnglish = reloaded.getByRole("group", { name: "Voice lines: English" });
  await expect(reloadedEnglish.getByRole("textbox", { name: "Check line 1" })).toHaveValue(BRIDGE_LINE);
  await expect(reloadedEnglish.getByRole("textbox", { name: "Check line 2" })).toHaveCount(0);
  await expect(reloadedEnglish.getByRole("textbox", { name: "Acknowledge line 1" })).toHaveCount(0);
  await expect(reloadedEnglish.getByLabel("Fallback line")).toHaveValue(FALLBACK_LINE);
  await expect(reloadedEnglish.getByLabel("Recording notice")).toHaveValue(RECORDING_NOTICE);
  await expect(reloadedEnglish.getByRole("textbox", { name: "Greeting line 1" })).toHaveValue(GREETING);
  await expect(reloaded.getByRole("group", { name: /^Voice lines: / })).toHaveCount(1);
});

test("an operator turns voice off, disconnects ElevenLabs, clears the voice lines, then the quick replies, and each clear is sent as an empty block", async ({ page }) => {
  const agentUpdates: unknown[] = [];
  const voiceConnectionRequests: string[] = [];
  const voiceChannelSwitches: boolean[] = [];
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    agentUpdates,
    voiceConnectionRequests,
    voiceChannelSwitches,
    voiceConnection: { vendorKey: "stored", managedVendorAgentId: VENDOR_AGENT_ID },
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
  await expect(card.getByText("Connected to ElevenLabs · recordings stay in the European Union")).toBeVisible();
  const voiceSwitch = card.getByRole("switch", { name: "Voice channel" });
  await expect(voiceSwitch).toBeChecked();
  await voiceSwitch.click();
  await expect(voiceSwitch).not.toBeChecked();
  // Off keeps the ElevenLabs agent, so turning voice on again calls no vendor.
  await expect(card.getByText("Connected to ElevenLabs · recordings stay in the European Union")).toBeVisible();
  expect(voiceChannelSwitches).toEqual([false]);

  await card.getByRole("button", { name: "Disconnect" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Disconnect ElevenLabs?" });
  await expect(confirm).toContainText("Radioso deletes the ElevenLabs agent it created for it.");
  await confirm.getByRole("button", { name: "Disconnect" }).click();
  await expect(card.getByRole("button", { name: "Disconnect" })).toHaveCount(0);
  await expect(voiceSwitch).toBeEnabled();
  expect(voiceConnectionRequests).toEqual(["DELETE"]);
  const english = card.getByRole("group", { name: "Voice lines: English" });
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
    { voice: { enabled: false, bridgeLines: {}, fallbackLine: {}, runtime: null, languageSwitching: false }, mechanicsReplies: { en: { greeting: [GREETING], ...noReplies } } },
    { voice: { enabled: false, bridgeLines: {}, fallbackLine: {}, runtime: null, languageSwitching: false }, mechanicsReplies: {} },
  ]);

  await page.reload();
  await expect(page.locator("#voice-channel").getByRole("switch", { name: "Voice channel" })).toBeVisible();
  await expect(page.locator("#voice-channel").getByRole("group", { name: /^Voice lines: / })).toHaveCount(0);
});

test("an operator turns on switching language with the caller, saves it, and finds it still on after a reload", async ({ page }) => {
  const agentUpdates: unknown[] = [];
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { agentUpdates });

  const card = await openVoiceCard(page);
  const languageSwitching = card.getByRole("switch", { name: "Switch language with the caller" });
  await expect(languageSwitching).not.toBeChecked();
  await languageSwitching.click();
  await save(card);

  expect(agentUpdates).toEqual([
    { voice: { enabled: false, bridgeLines: {}, fallbackLine: {}, runtime: null, languageSwitching: true }, mechanicsReplies: {} },
  ]);

  await page.reload();
  const reloaded = page.locator("#voice-channel");
  await expect(reloaded.getByRole("switch", { name: "Switch language with the caller" })).toBeChecked();
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

  await page.locator('[data-sidebar="sidebar"]').getByRole("button", { name: "support-desk", exact: true }).click();
  await page.getByRole("menuitem", { name: "sales-desk" }).click();
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
    voice: { enabled: false, bridgeLines: { en: { acknowledge: [], check: [otherBridgeLine] } }, fallbackLine: {}, runtime: null, languageSwitching: false },
    mechanicsReplies: {},
  }]);
  expect(agentUpdates).toEqual([]);
});

test("an operator without a stored key is asked for it when turning voice on, and cancelling leaves voice off", async ({ page }) => {
  const agentUpdates: unknown[] = [];
  const providerCredentialUpdates: Array<{ method: "PUT" | "DELETE"; provider: string; body?: unknown }> = [];
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { agentUpdates, providerCredentialUpdates, voiceConnection: { vendorKey: "missing" } });

  const card = await openVoiceCard(page);
  const voiceSwitch = card.getByRole("switch", { name: "Voice channel" });
  await voiceSwitch.click();

  const keyDialog = page.getByRole("dialog", { name: "ElevenLabs API key" });
  await expect(keyDialog).toContainText("Add your ElevenLabs API key. It needs the Agents permission, read and write.");
  await keyDialog.getByRole("button", { name: "Cancel" }).click();

  await expect(keyDialog).toHaveCount(0);
  await expect(voiceSwitch).not.toBeChecked();
  await expect(voiceSwitch).toBeEnabled();
  await expect(card.getByText("Connected to ElevenLabs", { exact: false })).toHaveCount(0);
  expect(providerCredentialUpdates).toEqual([]);
  expect(agentUpdates).toEqual([]);
});

test("an operator whose agent was never published is told on the Voice card that it takes no calls until it is", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { voiceCallReadiness: { ready: false, missing: "publication" } });

  const card = await openVoiceCard(page);

  await expect(card.getByText("Publish the agent first: until it is published, it answers no chats or calls.")).toBeVisible();
});

test("an operator hands an ElevenLabs agent set up by hand over to Radioso, and a save afterwards keeps the new binding", async ({ page }) => {
  const agentUpdates: unknown[] = [];
  const voiceConnectionRequests: string[] = [];
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    agentUpdates,
    voiceConnectionRequests,
    agentSettingsOverrides: {
      voice: { enabled: true, bridgeLines: {}, fallbackLine: {}, runtime: { vendor: "elevenlabs", agentId: "agent_by_hand", region: "us" } },
    },
    voiceConnection: { vendorKey: "stored", connectVendorAgentId: VENDOR_AGENT_ID, connectRegion: "sg" },
  });

  const card = await openVoiceCard(page);
  await expect(card.getByText("Uses an ElevenLabs agent set up outside Radioso.")).toBeVisible();
  await card.getByRole("button", { name: "Let Radioso manage it" }).click();
  await expect(card.getByText("Connected to ElevenLabs · recordings stay in Singapore")).toBeVisible();
  // Connect again repairs the agent Radioso maintains; the binding stays the same.
  await card.getByRole("button", { name: "Reconnect" }).click();
  await expect(card.getByText("Connected to ElevenLabs · recordings stay in Singapore")).toBeVisible();
  expect(voiceConnectionRequests).toEqual(["POST", "POST"]);
  await save(card);

  // The form took over the binding Connect wrote, so the whole-block save carries it rather than the stale one.
  expect(agentUpdates).toEqual([
    {
      voice: { enabled: true, bridgeLines: {}, fallbackLine: {}, runtime: { vendor: "elevenlabs", agentId: VENDOR_AGENT_ID, region: "sg" }, languageSwitching: false },
      mechanicsReplies: {},
    },
  ]);
});

test("an operator whose key may not manage agents is asked for one that may, and nothing is bound", async ({ page }) => {
  const agentUpdates: unknown[] = [];
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    agentUpdates,
    voiceConnection: { vendorKey: "stored", connectFailure: { status: 422, code: "voice_vendor_key_lacks_agents_permission" } },
  });

  const card = await openVoiceCard(page);
  const voiceSwitch = card.getByRole("switch", { name: "Voice channel" });
  await voiceSwitch.click();

  const keyDialog = page.getByRole("dialog", { name: "ElevenLabs API key" });
  await expect(keyDialog).toContainText("The ElevenLabs key lacks the Agents permission, read and write. Enter a key that has it.");
  await keyDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(voiceSwitch).not.toBeChecked();
  await expect(card.getByText("Connected to ElevenLabs", { exact: false })).toHaveCount(0);
  expect(agentUpdates).toEqual([]);
});

test("an operator who turns voice on while another change to the agent's voice runs is asked to wait, and voice stays off", async ({ page }) => {
  const agentUpdates: unknown[] = [];
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    agentUpdates,
    voiceConnection: { vendorKey: "stored", connectFailure: { status: 409, code: "voice_connection_busy" } },
  });

  const card = await openVoiceCard(page);
  const voiceSwitch = card.getByRole("switch", { name: "Voice channel" });
  await voiceSwitch.click();

  await expect(card.getByRole("alert")).toHaveText("Another change to this agent’s voice is still running. Try again in a moment.");
  await expect(voiceSwitch).not.toBeChecked();
  await expect(voiceSwitch).toBeEnabled();
  expect(agentUpdates).toEqual([]);
});
