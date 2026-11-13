import { expect, test, type Page } from "@playwright/test";

import type { components } from "../../../typescript-sdk/src/generated/types";
import { defaultAgentId, nowIso, workspaceId } from "./dashboard-fixtures";

// Picking a card (#1763, US3): a reply whose cards the visitor can pick shows a Select button under
// each; picking one sends it as the visitor's message, the agent answers about that item, and the
// pick is still shown after a reload, read back from the conversation's history. The backend reads
// the item from the stored reply; the mocks stand in with invented tours.

type ReplyBlock = components["schemas"]["ReplyBlock"];

const publicToken = "public-token-card-selection";
const conversationId = "conversation-card-selection";
const cardsMessageId = "7c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5";
const imageBase = "https://app.example/backend/api/v1/public/reply-images";
const theme = { brand: "#1e3a8a", brandText: "#eff6ff", surface: "#ffffff", text: "#0f172a" };

const question = "Which boat tours do you run?";
const cardsAnswer = "Three tours leave from the harbour every morning.";
const pickedAnswer = "The Lighthouse Loop takes two hours and stops at the old lighthouse.";

const tours: ReplyBlock = {
  type: "item_list",
  id: "b1",
  layout: "carousel",
  selection: "single",
  caption: "Boat tours",
  items: [
    ["Harbour Sunrise", "harbour-sunrise", "8a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c41"],
    ["Lighthouse Loop", "lighthouse-loop", "8a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c42"],
    ["Seal Island Run", "seal-island-run", "8a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c43"],
  ].map(([title, slug, imageId]) => ({
    key: imageId,
    title,
    image: { src: `${imageBase}/${imageId}/640`, alt: `A boat on the ${title} tour`, width: 640, height: 480 },
    actions: [{ type: "open" as const, url: `https://tours.example/${slug}` }, { type: "select" as const }],
  })),
};
const lighthouse = tours.items[1];
const pick = { method: "item_select", selection: { messageId: cardsMessageId, blockId: "b1", itemKey: lighthouse.key } };

/** The public chat as the backend serves it: a reply with cards, then a reply about the card picked. */
const mockPublicChat = async (page: Page) => {
  const sentBodies: Array<Record<string, unknown>> = [];
  const thread = () => [
    { id: "user-message-1", role: "user", source: "customer", content: question, createdAt: nowIso },
    { id: cardsMessageId, role: "assistant", source: "ai_agent", content: cardsAnswer, createdAt: nowIso, blocks: [tours] },
    ...(sentBodies.length > 1
      ? [
          { id: "user-message-2", role: "user", source: "customer", content: lighthouse.title, createdAt: nowIso, inputMetadata: pick },
          { id: "assistant-message-2", role: "assistant", source: "ai_agent", content: pickedAnswer, createdAt: nowIso },
        ]
      : []),
  ];
  await page.route("**/public/reply-images/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#1e3a8a"/></svg>`,
    }));
  await page.route(`**/backend/api/v1/public/chat/${publicToken}**`, async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname.endsWith("/sessions") && request.method() === "POST") {
      await route.fulfill({
        json: {
          agentId: defaultAgentId, agentName: "Mara", assistantLinkUtmEnabled: false, workspaceName: "Harbour Tours",
          publicChatToken: publicToken, publicSessionId: "22222222-2222-4222-8222-222222222222",
          publicSessionToken: "public-session-token", resumeToken: "resume-token", assistantBootstrapActive: false,
          assistantAvatarUrl: null, theme, branding: { hidePoweredBy: false, privacyPolicyUrl: null }, intakeActions: [],
        },
      });
      return;
    }
    if (pathname.includes("/history/")) {
      const messages = thread();
      await route.fulfill({
        json: {
          conversationId, workspaceId, agentId: defaultAgentId, sourceChannel: "anonymous", callerKind: "human",
          sourceOrigin: null, channelContext: null, title: null, createdAt: nowIso, updatedAt: nowIso,
          messageCount: messages.length, userMessageCount: messages.length / 2, assistantMessageCount: messages.length / 2,
          messagesTotal: messages.length, messageWindowOffset: 0, messageWindowLimit: 10, hasOlderMessages: false,
          nextCursor: null, tailCursor: "tail-cursor", messages,
        },
      });
      return;
    }
    if (pathname.includes("/tail/")) {
      await route.fulfill({ json: { messages: [], cursor: null } });
      return;
    }
    if (request.method() === "GET") {
      const messageCount = thread().length;
      await route.fulfill({
        json: {
          workspaceName: "Harbour Tours", assistantAvatarUrl: null, assistantLinkUtmEnabled: false, citationDisplayEnabled: true,
          theme, branding: { hidePoweredBy: false, privacyPolicyUrl: null }, intakeActions: [], assistantBootstrapActive: false,
          conversations: sentBodies.length > 0
            ? [{
                id: conversationId, agentId: defaultAgentId, agentName: "Mara", agentInternalName: null,
                sourceChannel: "anonymous", callerKind: "human", sourceOrigin: null, channelContext: null,
                anonymousSessionId: null, entryPageUrl: null, visitorCountry: null, title: null,
                createdAt: nowIso, updatedAt: nowIso, messageCount, userMessageCount: messageCount / 2,
                assistantMessageCount: messageCount / 2, preview: question,
              }]
            : [],
          total: sentBodies.length > 0 ? 1 : 0,
          nextCursor: null,
          hasMore: false,
        },
      });
      return;
    }
    await route.continue();
  });
  await page.route(`**/api/public/chat/${publicToken}`, async (route) => {
    sentBodies.push(JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>);
    const picked = sentBodies.length > 1;
    const done = picked
      ? { conversationId, assistantMessageId: "assistant-message-2", answer: pickedAnswer }
      : { conversationId, assistantMessageId: cardsMessageId, answer: cardsAnswer, blocks: [tours] };
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: [
        `event: conversation\ndata: ${JSON.stringify({ conversationId })}\n\n`,
        `event: chunk\ndata: ${JSON.stringify({ text: done.answer })}\n\n`,
        ...(picked ? [] : [`event: block\ndata: ${JSON.stringify({ conversationId, assistantMessageId: cardsMessageId, block: tours })}\n\n`]),
        `event: done\ndata: ${JSON.stringify(done)}\n\n`,
      ].join(""),
    });
  });
  return { sentBodies };
};

test("a visitor picks a card, the agent answers about it, and the pick is still shown after a reload", async ({ page }) => {
  const { sentBodies } = await mockPublicChat(page);

  await page.goto(`/chat/${publicToken}`);
  await page.getByPlaceholder("Ask a question...").fill(question);
  await page.getByRole("button", { name: "Send message" }).click();

  const cards = page.getByRole("list", { name: "Boat tours" });
  await expect(cards.getByRole("button", { name: /^Select / })).toHaveCount(3);

  await cards.getByRole("button", { name: "Select Lighthouse Loop" }).click();

  // The pick is the visitor's message, named by the card, and the agent answers about that tour.
  await expect(page.getByText(pickedAnswer)).toBeVisible();
  expect(sentBodies[1]).toMatchObject({ conversationId, message: lighthouse.title, inputMetadata: pick });
  await expect(cards.getByRole("button", { name: "Select Lighthouse Loop" })).toHaveAttribute("aria-pressed", "true");
  for (const name of ["Select Harbour Sunrise", "Select Seal Island Run"]) {
    await expect(cards.getByRole("button", { name })).toBeDisabled();
    await expect(cards.getByRole("button", { name })).toHaveAttribute("aria-pressed", "false");
  }

  // History keeps the pick, so the reloaded thread shows it and offers no second one.
  await page.reload();
  await expect(page.getByText(pickedAnswer)).toBeVisible();
  const reloaded = page.getByRole("list", { name: "Boat tours" });
  await expect(reloaded.getByRole("button", { name: "Select Lighthouse Loop" })).toHaveAttribute("aria-pressed", "true");
  await expect(reloaded.getByRole("button", { name: "Select Harbour Sunrise" })).toBeDisabled();
});
