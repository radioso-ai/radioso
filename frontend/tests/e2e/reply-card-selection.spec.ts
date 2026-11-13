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

/** One reply the mocked backend gives, in the order the visitor's messages arrive. */
interface ScriptedReply {
  id: string;
  answer: string;
  blocks?: ReplyBlock[];
}

/** A reply with cards, then a reply about the card picked. */
const tourReplies: ScriptedReply[] = [
  { id: cardsMessageId, answer: cardsAnswer, blocks: [tours] },
  { id: "assistant-message-2", answer: pickedAnswer },
];

/**
 * The public chat as the backend serves it: each message the visitor sends gets the next scripted
 * reply, and history reads back what was sent, a pick with its metadata, beside those replies.
 */
const mockPublicChat = async (page: Page, replies: ScriptedReply[] = tourReplies) => {
  const sentBodies: Array<Record<string, unknown>> = [];
  const thread = () => sentBodies.flatMap((body, index) => [
    {
      id: `user-message-${index + 1}`, role: "user", source: "customer", content: typeof body.message === "string" ? body.message : "", createdAt: nowIso,
      ...(body.inputMetadata ? { inputMetadata: body.inputMetadata } : {}),
    },
    {
      id: replies[index].id, role: "assistant", source: "ai_agent", content: replies[index].answer, createdAt: nowIso,
      ...(replies[index].blocks ? { blocks: replies[index].blocks } : {}),
    },
  ]);
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
                assistantMessageCount: messageCount / 2, preview: typeof sentBodies[0]?.message === "string" ? sentBodies[0].message : "",
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
    const reply = replies[sentBodies.length - 1];
    const done = { conversationId, assistantMessageId: reply.id, answer: reply.answer, ...(reply.blocks ? { blocks: reply.blocks } : {}) };
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: [
        `event: conversation\ndata: ${JSON.stringify({ conversationId })}\n\n`,
        `event: chunk\ndata: ${JSON.stringify({ text: reply.answer })}\n\n`,
        ...(reply.blocks ?? []).map((block) => `event: block\ndata: ${JSON.stringify({ conversationId, assistantMessageId: reply.id, block })}\n\n`),
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

// The chat's side of picking inside a routine (#1763, US7): the replies are mocked, so this checks
// what the chat sends and keeps, not the routine. A routine step's card is sent as a pick naming
// the reply that showed it, a typed answer after it carries no pick, and the cards keep the pick
// after a reload. The routine itself is covered by tests/integration/routine-present-select.
const choiceMessageId = "9d2e3f4a-5b6c-4d7e-8f90-a1b2c3d4e5f6";
const flats: ReplyBlock = {
  type: "item_list",
  id: "b1",
  layout: "list",
  selection: "single",
  caption: "Flats in Mitte",
  items: [
    ["/listings/0", "Loft on Torstrasse", "loft-torstrasse"],
    ["/listings/1", "Altbau flat on Auguststrasse", "altbau-auguststrasse"],
    ["/listings/3", "Garden flat on Linienstrasse", "garden-flat-linienstrasse"],
  ].map(([key, title, slug]) => ({
    key,
    title,
    description: "Mitte",
    actions: [{ type: "open" as const, url: `https://homes.example/listings/${slug}` }, { type: "select" as const }],
  })),
};
const altbau = flats.items[1];
const brief = "A flat in Mitte, up to 2,000 a month.";
const routineReplies: ScriptedReply[] = [
  { id: choiceMessageId, answer: "Three flats fit your budget. Which one would you like to view?", blocks: [flats] },
  { id: "assistant-message-2", answer: "You chose the Altbau flat on Auguststrasse. What's your email address, so an agent can arrange a viewing?" },
  { id: "assistant-message-3", answer: "Thanks! An agent will email you about viewing the Altbau flat on Auguststrasse." },
];

test("a routine step's card is sent as a pick, a typed answer after it as a plain message, and the cards keep the pick after a reload", async ({ page }) => {
  const { sentBodies } = await mockPublicChat(page, routineReplies);

  await page.goto(`/chat/${publicToken}`);
  await page.getByPlaceholder("Ask a question...").fill(brief);
  await page.getByRole("button", { name: "Send message" }).click();

  const cards = page.getByRole("list", { name: "Flats in Mitte" });
  await expect(cards.getByRole("button", { name: /^Select / })).toHaveCount(3);
  await cards.getByRole("button", { name: `Select ${altbau.title}` }).click();

  // The pick is a structured fact the routine reads; the step after it names the flat.
  await expect(page.getByText(routineReplies[1].answer)).toBeVisible();
  expect(sentBodies[1]).toMatchObject({
    conversationId,
    message: altbau.title,
    inputMetadata: { method: "item_select", selection: { messageId: choiceMessageId, blockId: "b1", itemKey: altbau.key } },
  });

  // The routine goes on with a typed answer, which carries no pick.
  await page.getByPlaceholder("Ask a question...").fill("ada@mail.example");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText(routineReplies[2].answer)).toBeVisible();
  expect(sentBodies[2]).toMatchObject({ conversationId, message: "ada@mail.example", inputMetadata: { method: "typed" } });

  // The cards keep the pick, and no other flat can be picked from them, after a reload too.
  await page.reload();
  await expect(page.getByText(routineReplies[2].answer)).toBeVisible();
  const reloaded = page.getByRole("list", { name: "Flats in Mitte" });
  await expect(reloaded.getByRole("button", { name: `Select ${altbau.title}` })).toHaveAttribute("aria-pressed", "true");
  await expect(reloaded.getByRole("button", { name: "Select Loft on Torstrasse" })).toBeDisabled();
});
