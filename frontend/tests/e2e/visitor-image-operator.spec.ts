import { expect, test } from "@playwright/test";

import {
  defaultAgentId,
  installDashboardApiMocks,
  nowIso,
  seedDashboardStorage,
  workspaceId,
  workspaceKey,
} from "./dashboard-fixtures";

// A teammate opening a conversation in Activity sees the photos the visitor sent beside what they
// typed, loaded from the audited conversation route when the thread shows them, and the agent's
// reading of each photo behind a disclosure rather than inside the visitor's bubble.

const conversationId = "11111111-1111-4111-8111-111111111111";
const imageId = "6c3e9f2a-1d4b-4b8e-9f0a-2a4c6e8b0d12";
const typedText = "Something like this, near the coast";
const reading = "A two-storey stone farmhouse with a terracotta roof and green shutters.";
// A 1x1 GIF the browser decodes, served as the photo: the route's content is not what this spec checks.
const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAUEBAAAACwAAAAAAQABAAACAkQBADs=", "base64");

test("a teammate sees the visitor's photos in the conversation, loaded on demand, with the agent's reading behind a disclosure", async ({ page }) => {
  const conversation = {
    id: conversationId,
    agentId: defaultAgentId,
    agentName: "Marta",
    agentInternalName: null,
    sourceChannel: "anonymous",
    sourceOrigin: null,
    entryPageUrl: null,
    channelContext: null,
    anonymousSessionId: "visitor-session-1",
    createdAt: nowIso,
    updatedAt: nowIso,
    messageCount: 2,
    userMessageCount: 1,
    assistantMessageCount: 1,
    preview: typedText,
    title: null,
  };
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    historyItems: {
      items: [{ kind: "chat", id: conversationId, sortAt: nowIso, conversation }],
      total: 1,
      nextCursor: null,
      hasMore: false,
    },
    conversationDetails: {
      [conversationId]: {
        conversationId,
        workspaceId,
        agentId: defaultAgentId,
        agentName: "Marta",
        sourceChannel: "anonymous",
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
        title: null,
        privacyNoticeVersion: null,
        visitor: { id: "22222222-2222-4222-8222-222222222222", firstSeenAt: nowIso, conversationCount: 1, verified: false },
        requestContext: null,
        messages: [
          {
            id: "user-message-1",
            role: "user" as const,
            source: "customer" as const,
            // The turn text the agent saw. A thread shows the typed text and the photos, never this.
            content: `${typedText}\n<attached_photo index="1">${reading}</attached_photo>`,
            createdAt: nowIso,
            inputMetadata: { method: "typed", imageInput: { typedText, images: [{ id: imageId, reading }] } },
          },
          { id: "assistant-message-1", role: "assistant" as const, source: "ai_agent" as const, content: "I found three farmhouses on the coast.", createdAt: nowIso },
        ],
      },
    },
  });

  const imageRequests: string[] = [];
  await page.route(`**/backend/api/v1/conversations/${conversationId}/images/${imageId}**`, async (route) => {
    imageRequests.push(route.request().url());
    await route.fulfill({ status: 200, contentType: "image/gif", body: PIXEL });
  });

  await page.goto(`/w/${workspaceKey}/activity?tab=all`);
  // Listing conversations loads no photo.
  await expect(page.getByRole("button", { name: new RegExp(typedText) })).toBeVisible();
  expect(imageRequests).toHaveLength(0);

  await page.getByRole("button", { name: new RegExp(typedText) }).click();
  const photo = page.getByTestId("visitor-image-thumbnails").getByRole("img", { name: "Photo the visitor sent" });
  await expect(photo).toBeVisible();
  await expect.poll(() => photo.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);

  // The dashboard's own route, with the workspace in the query because an <img> cannot send the header.
  expect(imageRequests.length).toBeGreaterThan(0);
  const url = new URL(imageRequests[0]);
  expect(url.pathname).toBe(`/backend/api/v1/conversations/${conversationId}/images/${imageId}`);
  expect(url.searchParams.get("workspaceId")).toBe(workspaceId);

  // The visitor's words sit beside the photo; the agent's reading sits behind the disclosure, not in the bubble.
  await expect(page.locator('[data-message-role="user"]').getByText(typedText, { exact: true })).toBeVisible();
  await expect(page.getByText(reading)).toHaveCount(0);
  await page.getByRole("button", { name: "What the agent read" }).click();
  await expect(page.getByText(reading)).toBeVisible();
  await expect(page.getByText("attached_photo")).toHaveCount(0);
});

test("a photo far down a long conversation is not asked for, and so not audited as seen, until it is on screen", async ({ page }) => {
  const filler = (index: number) => [
    { id: `user-filler-${index}`, role: "user" as const, source: "customer" as const, content: `Question ${index}: ${"a long line about the property, ".repeat(12)}`, createdAt: nowIso },
    { id: `assistant-filler-${index}`, role: "assistant" as const, source: "ai_agent" as const, content: `Answer ${index}: ${"a long reply about the property, ".repeat(12)}`, createdAt: nowIso },
  ];
  const messages = [
    ...Array.from({ length: 12 }, (_, index) => filler(index)).flat(),
    {
      id: "user-message-photo",
      role: "user" as const,
      source: "customer" as const,
      content: `${typedText}\n<attached_photo index="1">${reading}</attached_photo>`,
      createdAt: nowIso,
      inputMetadata: { method: "typed", imageInput: { typedText, images: [{ id: imageId, reading }] } },
    },
    ...Array.from({ length: 12 }, (_, index) => filler(index + 12)).flat(),
  ];
  const conversation = {
    id: conversationId,
    agentId: defaultAgentId,
    agentName: "Marta",
    agentInternalName: null,
    sourceChannel: "anonymous",
    sourceOrigin: null,
    entryPageUrl: null,
    channelContext: null,
    anonymousSessionId: "visitor-session-1",
    createdAt: nowIso,
    updatedAt: nowIso,
    messageCount: messages.length,
    userMessageCount: 25,
    assistantMessageCount: 24,
    preview: "Question 0",
    title: null,
  };
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    historyItems: { items: [{ kind: "chat", id: conversationId, sortAt: nowIso, conversation }], total: 1, nextCursor: null, hasMore: false },
    conversationDetails: {
      [conversationId]: {
        conversationId,
        workspaceId,
        agentId: defaultAgentId,
        agentName: "Marta",
        sourceChannel: "anonymous",
        sourceOrigin: null,
        channelContext: null,
        createdAt: nowIso,
        updatedAt: nowIso,
        messageCount: messages.length,
        userMessageCount: 25,
        assistantMessageCount: 24,
        messagesTotal: messages.length,
        messageWindowOffset: 0,
        messageWindowLimit: 100,
        hasOlderMessages: false,
        nextCursor: null,
        title: null,
        privacyNoticeVersion: null,
        visitor: { id: "22222222-2222-4222-8222-222222222222", firstSeenAt: nowIso, conversationCount: 1, verified: false },
        requestContext: null,
        messages,
      },
    },
  });
  const imageRequests: string[] = [];
  await page.route(`**/backend/api/v1/conversations/${conversationId}/images/${imageId}**`, async (route) => {
    imageRequests.push(route.request().url());
    await route.fulfill({ status: 200, contentType: "image/gif", body: PIXEL });
  });

  await page.goto(`/w/${workspaceKey}/activity?tab=all`);
  await page.getByRole("button", { name: /Question 0/ }).click();
  await expect(page.locator('[data-message-id="user-filler-0"]')).toBeAttached();
  const frame = page.getByTestId("visitor-image-thumbnails");
  await expect(frame).toBeAttached();

  // The photo sits a long way from where the thread opens, whichever end that is: wherever the
  // thread is scrolled to, it is not on screen, so it is not asked for and not recorded as viewed.
  const photo = page.getByRole("img", { name: "Photo the visitor sent" });
  await page.waitForTimeout(700);
  expect(await frame.evaluate((element) => { const box = element.getBoundingClientRect(); return box.bottom < 0 || box.top > window.innerHeight; })).toBe(true);
  expect(imageRequests).toHaveLength(0);
  await expect(photo).toHaveCount(0);

  // Scrolled to, it loads, once.
  await frame.scrollIntoViewIfNeeded();
  await expect(photo).toBeVisible();
  await expect.poll(() => photo.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
  expect(imageRequests).toHaveLength(1);
});

// The setting that lets visitors send photos lives with the agent's live answer settings.

test("an operator turns on photos for an agent from its Answers settings", async ({ page }) => {
  await seedDashboardStorage(page);
  const agentUpdates: unknown[] = [];
  await installDashboardApiMocks(page, { agentUpdates });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-profile`);
  const toggle = page.getByRole("switch", { name: "Let visitors send photos" });
  await expect(toggle).toBeVisible();
  await expect(toggle).not.toBeChecked();
  await expect(page.getByText("can’t read photos")).toHaveCount(0);

  await toggle.click();

  await expect.poll(() => agentUpdates).toEqual(expect.arrayContaining([expect.objectContaining({ visitorImagesEnabled: true })]));
  await expect(toggle).toBeChecked();
});

test("the photos setting says when the agent's model cannot read them, and cannot be turned on", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    agentSettingsOverrides: { chatModelOverride: { provider: "openai-compatible", model: "llava" } },
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-profile`);
  const toggle = page.getByRole("switch", { name: "Let visitors send photos" });
  await expect(toggle).toBeVisible();
  await expect(page.getByText("This agent’s chat model can’t read photos. Pick another model to turn this on.")).toBeVisible();
  await expect(toggle).toBeDisabled();
  await expect(toggle).not.toBeChecked();
});
