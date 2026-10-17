import { expect, test, type Page } from "@playwright/test";

import {
  defaultAgentId,
  installDashboardApiMocks,
  nowIso,
  seedDashboardStorage,
  workspaceId,
  workspaceKey,
} from "./dashboard-fixtures";

// A voice call's recording stays with the voice vendor; the Inbox plays it through the backend's
// recording route when a teammate presses Listen, and offers Listen only when the conversation's
// detail says the call has one.
const conversationId = "conversation-voice-recorded";

const conversation = {
  id: conversationId,
  agentId: defaultAgentId,
  agentName: "Gioia",
  agentInternalName: null,
  sourceChannel: "voice",
  sourceOrigin: null,
  entryPageUrl: null,
  channelContext: null,
  anonymousSessionId: null,
  createdAt: nowIso,
  updatedAt: nowIso,
  messageCount: 2,
  userMessageCount: 1,
  assistantMessageCount: 1,
  preview: "When do you open on Saturday?",
};

const otherConversationId = "conversation-voice-other";
const otherConversation = { ...conversation, id: otherConversationId, preview: "Do you deliver on Sundays?" };

const conversationDetail = (recording: { available: boolean } | undefined, id = conversationId) => ({
  conversationId: id,
  workspaceId,
  agentId: defaultAgentId,
  agentName: "Gioia",
  sourceChannel: "voice",
  sourceOrigin: null,
  channelContext: null,
  createdAt: nowIso,
  updatedAt: nowIso,
  messageCount: 2,
  userMessageCount: 1,
  assistantMessageCount: 1,
  messagesTotal: 2,
  messageWindowOffset: 0,
  messageWindowLimit: 50,
  hasOlderMessages: false,
  nextCursor: null,
  messages: [
    { id: "user-message-saturday", role: "user" as const, source: "customer" as const, content: "When do you open on Saturday?", createdAt: nowIso },
    id === conversationId
      ? { id: "assistant-message-saturday", role: "assistant" as const, source: "ai_agent" as const, content: "We open at ten on Saturdays.", createdAt: nowIso }
      : { id: "assistant-message-sunday", role: "assistant" as const, source: "ai_agent" as const, content: "We deliver every day but Sunday.", createdAt: nowIso },
  ],
  ...(recording ? { recording } : {}),
});

/** A quarter second of 8 kHz mono silence as WAV, which the browser's audio element plays. */
const silentWav = (): Buffer => {
  const samples = 2_000;
  const data = Buffer.alloc(samples * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8_000, 24);
  header.writeUInt32LE(16_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
};

const openConversation = async (page: Page, options: { recording?: { available: boolean }; recordingStatus?: number }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    historyItems: {
      items: [
        { kind: "chat", id: conversationId, sortAt: nowIso, conversation },
        { kind: "chat", id: otherConversationId, sortAt: nowIso, conversation: otherConversation },
      ],
      total: 2,
      nextCursor: null,
      hasMore: false,
    },
    historyList: { conversations: [conversation, otherConversation], total: 2, nextCursor: null, hasMore: false },
    conversationDetail: conversationDetail(options.recording),
    conversationDetails: { [otherConversationId]: conversationDetail(options.recording, otherConversationId) },
  });
  const recordingRequests: URL[] = [];
  await page.route("**/backend/api/v1/conversations/*/recording**", async (route) => {
    recordingRequests.push(new URL(route.request().url()));
    const status = options.recordingStatus ?? 200;
    await (status === 200
      ? route.fulfill({ status, contentType: "audio/wav", headers: { "cache-control": "private, no-store" }, body: silentWav() })
      : route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ error: { code: "recording_unavailable", message: "x" } }) }));
  });
  await page.goto(`/w/${workspaceKey}/activity?tab=all&filter=chat&itemKind=chat&itemId=${conversationId}`);
  const response = page.getByLabel("Response", { exact: true });
  await expect(response.getByText("We open at ten on Saturdays.")).toBeVisible();
  return { response, recordingRequests };
};

test("a call with a recording offers Listen, which plays it from the recording route for this workspace", async ({ page }) => {
  const { response, recordingRequests } = await openConversation(page, { recording: { available: true } });
  // Nothing is fetched until the teammate asks: each play is audited against them.
  expect(recordingRequests).toHaveLength(0);

  await response.getByRole("button", { name: "Listen" }).click();

  const player = response.getByLabel("Call recording");
  await expect(player).toBeVisible();
  await expect.poll(() => recordingRequests.length).toBeGreaterThan(0);
  expect(recordingRequests[0].pathname).toBe(`/backend/api/v1/conversations/${conversationId}/recording`);
  expect(recordingRequests[0].searchParams.get("workspaceId")).toBe(workspaceId);
  await expect.poll(() => player.evaluate((element) => (element as HTMLAudioElement).error === null && (element as HTMLAudioElement).readyState > 0)).toBe(true);

  await response.getByRole("button", { name: "Listen" }).click();
  await expect(player).toHaveCount(0);
});

test("coming back to a conversation never resumes its player: a play is only ever a press", async ({ page }) => {
  const { response, recordingRequests } = await openConversation(page, { recording: { available: true } });
  await response.getByRole("button", { name: "Listen" }).click();
  await expect(response.getByLabel("Call recording")).toBeVisible();
  await expect.poll(() => recordingRequests.length).toBeGreaterThan(0);

  await page.getByText("Do you deliver on Sundays?").first().click();
  await expect(response.getByText("We deliver every day but Sunday.")).toBeVisible();
  await expect(response.getByLabel("Call recording")).toHaveCount(0);
  await page.getByText("When do you open on Saturday?").first().click();
  await expect(response.getByText("We open at ten on Saturdays.")).toBeVisible();

  const requestsBeforeReturn = recordingRequests.length;
  await expect(response.getByRole("button", { name: "Listen" })).toHaveAttribute("aria-pressed", "false");
  await expect(response.getByLabel("Call recording")).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(recordingRequests.length).toBe(requestsBeforeReturn);
});

test("a call whose recording cannot be read says so in the player's place", async ({ page }) => {
  const { response } = await openConversation(page, { recording: { available: true }, recordingStatus: 503 });

  await response.getByRole("button", { name: "Listen" }).click();

  await expect(response.getByText("The recording can’t be played right now.")).toBeVisible();
});

test("a call without a recording offers no Listen", async ({ page }) => {
  const { response } = await openConversation(page, { recording: { available: false } });

  await expect(response.getByRole("button", { name: "Open in debug view" })).toBeVisible();
  await expect(response.getByRole("button", { name: "Listen" })).toHaveCount(0);
});

test("a detail that says nothing of a recording offers no Listen", async ({ page }) => {
  const { response } = await openConversation(page, {});

  await expect(response.getByRole("button", { name: "Open in debug view" })).toBeVisible();
  await expect(response.getByRole("button", { name: "Listen" })).toHaveCount(0);
});

