import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import type { components } from "../../../typescript-sdk/src/generated/types";
import {
  defaultAgentId,
  installDashboardApiMocks,
  nowIso,
  seedDashboardStorage,
  workspaceId,
  workspaceKey,
} from "./dashboard-fixtures";

// Reply blocks in the chat (#1763): an answer that presents items shows them under its text as
// picture cards, each opening its page, and the cards come back with the conversation's history,
// for the visitor and for the operator. The backend picks the items and serves their pictures; the
// mocks stand in with invented guides and rooms.

type ReplyBlock = components["schemas"]["ReplyBlock"];

const publicToken = "public-token-reply-blocks";
const conversationId = "conversation-reply-blocks";
const imageBase = "https://app.example/backend/api/v1/public/reply-images";
const theme = { brand: "#14532d", brandText: "#f0fdf4", surface: "#ffffff", text: "#0f172a" };

const picture = (imageId: string, alt: string, width: number, height: number) => ({
  src: `${imageBase}/${imageId}/640`,
  srcSet: `${imageBase}/${imageId}/320 320w, ${imageBase}/${imageId}/640 640w`,
  alt,
  width,
  height,
});

const guidesQuestion = "Which hiking guides do you have?";
const guidesAnswer = "Three guides cover the trails you asked about.";
const guides: ReplyBlock = {
  type: "item_list",
  id: "block-guides",
  layout: "carousel",
  selection: "none",
  caption: "Hiking guides in stock",
  items: [
    ["Ridge Walks of the Northern Valleys", "ridge-walks", "0b3c7a52-6a2e-4c1b-9d34-1f2e3a4b5c61"],
    ["Lakeside Trails for Every Season", "lakeside-trails", "0b3c7a52-6a2e-4c1b-9d34-1f2e3a4b5c62"],
    ["The Hut-to-Hut Handbook", "hut-to-hut", "0b3c7a52-6a2e-4c1b-9d34-1f2e3a4b5c63"],
  ].map(([title, slug, imageId]) => ({
    key: imageId,
    title,
    image: picture(imageId, `Cover of ${title}`, 640, 960),
    actions: [{ type: "open" as const, url: `https://shop.example/books/${slug}` }],
  })),
};

const missingRoomImageId = "5d1e2f30-4a5b-4c6d-8e7f-90a1b2c3d4e3";
const roomsQuestion = "What do the rooms look like?";
const roomsAnswer = "Each room opens onto the garden or the hills.";
const rooms: ReplyBlock = {
  type: "item_list",
  id: "block-rooms",
  layout: "grid",
  selection: "none",
  caption: "Rooms at the guest house",
  items: [
    ["Garden room", "A bright room with doors onto the garden", "5d1e2f30-4a5b-4c6d-8e7f-90a1b2c3d4e1"],
    ["Hill view room", "A room with a window over the hills", "5d1e2f30-4a5b-4c6d-8e7f-90a1b2c3d4e2"],
    ["Attic room", "A sloped ceiling over a reading corner", missingRoomImageId],
  ].map(([title, alt, imageId]) => ({
    key: imageId,
    title,
    image: picture(imageId, alt, 640, 480),
    actions: [],
  })),
};

const stayQuestion = "Where can I stay near the trails?";
const stayAnswer = "A hut sits on the ridge, and the valley lodge has rooms by the river.";
const huts: ReplyBlock = {
  type: "item_list",
  id: "block-huts",
  layout: "carousel",
  selection: "none",
  caption: "Huts on the ridge",
  items: [
    {
      key: "7a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c81",
      title: "",
      image: picture("7a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c81", "A stone hut under the ridge", 640, 480),
      actions: [{ type: "open", url: "https://shop.example/huts/stone" }],
    },
    {
      key: "7a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c82",
      title: "Saddle hut",
      image: picture("7a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c82", "A wooden hut on the saddle", 640, 480),
      actions: [],
    },
  ],
};
const lodgeRooms: ReplyBlock = {
  type: "item_list",
  id: "block-lodge",
  layout: "list",
  selection: "none",
  caption: "Rooms at the valley lodge",
  items: [{
    key: "7a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c83",
    title: "Twin room",
    description: "Two beds and a window over the river",
    image: picture("7a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c83", "A twin room with a river view", 640, 480),
    actions: [{ type: "open", url: "https://shop.example/lodge/twin" }],
  }],
};

/** The image route: every picture is a plain drawing, except one whose document was deleted. */
const servePictures = async (page: Page) => {
  await page.route("**/public/reply-images/**", async (route) => {
    const imageId = new URL(route.request().url()).pathname.split("/").at(-2) ?? "";
    if (imageId === missingRoomImageId) {
      await route.fulfill({ status: 404, body: "" });
      return;
    }
    await route.fulfill({
      contentType: "image/svg+xml",
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="960"><rect width="640" height="960" fill="#3f6f5a"/><circle cx="320" cy="400" r="160" fill="#f5e6c8"/></svg>`,
    });
  });
};

/** A shop page each card opens in a new tab. */
const serveShopPages = (context: BrowserContext) =>
  context.route("https://shop.example/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Guide</title><h1>Guide</h1>" }));

const conversationMessages = (question: string, answer: string, blocks: ReplyBlock[]) => [
  { id: "user-message-1", role: "user" as const, source: "customer" as const, content: question, createdAt: nowIso },
  { id: "assistant-message-1", role: "assistant" as const, source: "ai_agent" as const, content: answer, createdAt: nowIso, blocks },
];

/** The public chat as the backend serves it: one question, answered with blocks, then read back. */
const mockPublicChat = async (page: Page, reply: { question: string; answer: string; blocks: ReplyBlock[] }) => {
  const sentBodies: Array<Record<string, unknown>> = [];
  let answered = false;
  const conversationList = () => ({
    workspaceName: "Trail Books",
    assistantAvatarUrl: null,
    assistantLinkUtmEnabled: false,
    citationDisplayEnabled: true,
    theme,
    branding: { hidePoweredBy: false, privacyPolicyUrl: null },
    intakeActions: [],
    assistantBootstrapActive: false,
    conversations: answered
      ? [{
          id: conversationId, agentId: defaultAgentId, agentName: "Wren", agentInternalName: null,
          sourceChannel: "anonymous", callerKind: "human", sourceOrigin: null, channelContext: null,
          anonymousSessionId: null, entryPageUrl: null, visitorCountry: null, title: null,
          createdAt: nowIso, updatedAt: nowIso, messageCount: 2, userMessageCount: 1, assistantMessageCount: 1,
          preview: reply.question,
        }]
      : [],
    total: answered ? 1 : 0,
    nextCursor: null,
    hasMore: false,
  });
  await page.route(`**/backend/api/v1/public/chat/${publicToken}**`, async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname.endsWith("/sessions") && request.method() === "POST") {
      await route.fulfill({
        json: {
          agentId: defaultAgentId, agentName: "Wren", assistantLinkUtmEnabled: false, workspaceName: "Trail Books",
          publicChatToken: publicToken, publicSessionId: "11111111-1111-4111-8111-111111111111",
          publicSessionToken: "public-session-token", resumeToken: "resume-token", assistantBootstrapActive: false,
          assistantAvatarUrl: null, theme, branding: { hidePoweredBy: false, privacyPolicyUrl: null }, intakeActions: [],
        },
      });
      return;
    }
    if (pathname.includes("/history/")) {
      await route.fulfill({
        json: {
          conversationId, workspaceId, agentId: defaultAgentId, sourceChannel: "anonymous", callerKind: "human",
          sourceOrigin: null, channelContext: null, title: null, createdAt: nowIso, updatedAt: nowIso,
          messageCount: 2, userMessageCount: 1, assistantMessageCount: 1, messagesTotal: 2,
          messageWindowOffset: 0, messageWindowLimit: 10, hasOlderMessages: false, nextCursor: null,
          tailCursor: "assistant-message-1-cursor",
          messages: conversationMessages(reply.question, reply.answer, reply.blocks),
        },
      });
      return;
    }
    if (pathname.includes("/tail/")) {
      await route.fulfill({ json: { messages: [], cursor: null } });
      return;
    }
    if (request.method() === "GET") {
      await route.fulfill({ json: conversationList() });
      return;
    }
    await route.continue();
  });
  await page.route(`**/api/public/chat/${publicToken}`, async (route) => {
    sentBodies.push(JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>);
    answered = true;
    const done = { conversationId, assistantMessageId: "assistant-message-1", answer: reply.answer, blocks: reply.blocks };
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: [
        `event: conversation\ndata: ${JSON.stringify({ conversationId })}\n\n`,
        `event: chunk\ndata: ${JSON.stringify({ text: reply.answer })}\n\n`,
        ...reply.blocks.map((block) =>
          `event: block\ndata: ${JSON.stringify({ conversationId, assistantMessageId: done.assistantMessageId, block })}\n\n`),
        `event: done\ndata: ${JSON.stringify(done)}\n\n`,
      ].join(""),
    });
  });
  return { sentBodies };
};

const ask = async (page: Page, question: string) => {
  await page.getByPlaceholder("Ask a question...").fill(question);
  await page.getByRole("button", { name: "Send message" }).click();
};

test("a visitor sees the guides an answer presents as cards that open their pages, and finds them again after a reload", async ({ page, context }) => {
  await servePictures(page);
  await serveShopPages(context);
  const { sentBodies } = await mockPublicChat(page, { question: guidesQuestion, answer: guidesAnswer, blocks: [guides] });

  await page.goto(`/chat/${publicToken}`);
  await ask(page, guidesQuestion);

  await expect(page.getByText(guidesAnswer)).toBeVisible();
  const cards = page.getByRole("list", { name: "Hiking guides in stock" });
  await expect(cards.getByRole("listitem")).toHaveCount(3);
  await expect(cards.getByRole("img", { name: "Cover of Ridge Walks of the Northern Valleys" })).toBeVisible();
  // The chat says which blocks it draws, so the backend sends them at all.
  expect(sentBodies[0]).toMatchObject({
    clientContextCapabilities: { "reply.blocks": { item_list: { layouts: ["carousel", "grid"] } } },
  });

  // A card opens its page in a new tab and leaves the chat where it was.
  const opened = page.waitForEvent("popup");
  await cards.getByRole("link", { name: "Ridge Walks of the Northern Valleys" }).click();
  const shopPage = await opened;
  await shopPage.waitForLoadState();
  expect(shopPage.url()).toBe("https://shop.example/books/ridge-walks");
  await shopPage.close();
  await expect(page.getByText(guidesAnswer)).toBeVisible();

  // The conversation comes back from history with its cards.
  await page.reload();
  await expect(page.getByText(guidesAnswer)).toBeVisible();
  const reloaded = page.getByRole("list", { name: "Hiking guides in stock" });
  await expect(reloaded.getByRole("link")).toHaveCount(3);
  await expect(reloaded.getByRole("link", { name: "The Hut-to-Hut Handbook" })).toBeVisible();
});

test("a gallery shows a page's pictures with their titles, and a picture that no longer loads leaves its tile without it", async ({ page }) => {
  await servePictures(page);
  await mockPublicChat(page, { question: roomsQuestion, answer: roomsAnswer, blocks: [rooms] });

  await page.goto(`/chat/${publicToken}`);
  await ask(page, roomsQuestion);

  const gallery = page.getByRole("list", { name: "Rooms at the guest house" });
  await expect(gallery.getByRole("listitem")).toHaveCount(3);
  await expect(gallery.getByRole("img", { name: "A bright room with doors onto the garden" })).toBeVisible();
  await expect(gallery.getByText("Attic room")).toBeVisible();
  await expect(gallery.getByRole("img", { name: "A sloped ceiling over a reading corner" })).toHaveCount(0);
  // Pictures without a page are shown, not linked.
  await expect(gallery.getByRole("link")).toHaveCount(0);
});

test("a card's link is named by its title, or by its picture without one, and a strip with an unlinked card scrolls from the keyboard", async ({ page }) => {
  await servePictures(page);
  await mockPublicChat(page, { question: stayQuestion, answer: stayAnswer, blocks: [huts, lodgeRooms] });

  await page.goto(`/chat/${publicToken}`);
  await ask(page, stayQuestion);

  const strip = page.getByRole("list", { name: "Huts on the ridge" });
  await expect(strip.getByRole("link")).toHaveAccessibleName("A stone hut under the ridge");
  // Tabbing passes over the saddle hut, which has no page, so the strip takes focus to scroll to it.
  await strip.focus();
  await expect(strip).toBeFocused();

  const rows = page.getByRole("list", { name: "Rooms at the valley lodge" });
  await expect(rows.getByRole("link", { name: "Twin room" })).toHaveAccessibleDescription("Two beds and a window over the river");
});

test("an operator sees the cards an answer showed when opening the conversation in the Inbox", async ({ page }) => {
  const conversation = {
    id: conversationId, agentId: defaultAgentId, agentName: "Wren", agentInternalName: null,
    sourceChannel: "anonymous", sourceOrigin: null, entryPageUrl: null, channelContext: null,
    anonymousSessionId: "visitor-session-1", createdAt: nowIso, updatedAt: nowIso,
    messageCount: 2, userMessageCount: 1, assistantMessageCount: 1, preview: guidesQuestion, title: null,
  };
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    historyItems: { items: [{ kind: "chat", id: conversationId, sortAt: nowIso, conversation }], total: 1, nextCursor: null, hasMore: false },
    conversationDetails: {
      [conversationId]: {
        conversationId, workspaceId, agentId: defaultAgentId, agentName: "Wren", sourceChannel: "anonymous",
        sourceOrigin: null, channelContext: null, createdAt: nowIso, updatedAt: nowIso,
        messageCount: 2, userMessageCount: 1, assistantMessageCount: 1, messagesTotal: 2,
        messageWindowOffset: 0, messageWindowLimit: 50, hasOlderMessages: false, nextCursor: null, title: null,
        requestContext: null,
        messages: conversationMessages(guidesQuestion, guidesAnswer, [guides]),
      },
    },
  });
  // Registered after the dashboard's catch-all, so the image route answers first.
  await servePictures(page);

  await page.goto(`/w/${workspaceKey}/activity?tab=all`);
  await expect(page.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: guidesQuestion }).click();

  const cards = page.getByLabel("Response", { exact: true }).getByRole("list", { name: "Hiking guides in stock" });
  await expect(cards.getByRole("link")).toHaveCount(3);
  await expect(cards.getByRole("img", { name: "Cover of Lakeside Trails for Every Season" })).toBeVisible();
});
