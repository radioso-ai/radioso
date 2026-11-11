import { expect, test, type Page, type Route } from "@playwright/test";

// A routine's consent on the website embed (#1544): before a step that collects a sensitive field,
// the agent sends the operator's wording verbatim with the two authored labels as buttons, and a
// click on one is sent as a structured decision: the chip's id and the message that showed it, so
// the backend records the decision on that wording without reading the label. Once decided, the
// buttons are gone, after a reload too. Driven through the real launcher and chat frame, with the
// network mocked at its edges.

const TOKEN = "e2e-consent-token";
const CONVERSATION_ID = "44444444-4444-4444-8444-444444444444";
const PROMPT_ID = "6f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5";
const NEXT_STEP_ID = "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d";
const FIRST_MESSAGE = "I'd like to book a yoga class";
const WORDING = "We ask about injuries only to adapt your class. Your answer stays with this booking.";
const NEXT_STEP = "Thanks. Do you have any injury we should plan around?";

// The host page is served through the test's route, which Chromium treats as a public address; it
// would otherwise refuse that page the app host on the loopback address.
test.use({ launchOptions: { args: ["--disable-features=LocalNetworkAccessChecks"] } });

const fulfillJson = (route: Route, body: unknown) =>
  route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

const bootstrapSessionPayload = () => ({
  workspaceName: "Acme Classes",
  agentId: "agent-1",
  agentName: "Classes",
  assistantLinkUtmEnabled: false,
  citationDisplayEnabled: true,
  publicChatToken: TOKEN,
  publicSessionId: "11111111-1111-4111-8111-111111111111",
  publicSessionToken: "public-session-token",
  resumeToken: "resume-token",
  assistantBootstrapActive: false,
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  resumeExpiresAt: new Date(Date.now() + 600_000).toISOString(),
});

/** One streamed turn as the backend sends it: the conversation, the text, and the completion. */
const streamedTurn = (done: Record<string, unknown>) => [
  `event: conversation\ndata: ${JSON.stringify({ conversationId: CONVERSATION_ID })}\n\n`,
  `event: chunk\ndata: ${JSON.stringify({ text: done.answer })}\n\n`,
  `event: done\ndata: ${JSON.stringify({ conversationId: CONVERSATION_ID, ...done })}\n\n`,
].join("");

const CONSENT_CHIPS = [
  { id: "agree", text: "I agree", kind: "authored", action: { kind: "ask_followup" } },
  { id: "decline", text: "No thanks", kind: "authored", action: { kind: "ask_followup" } },
];

/**
 * The conversation as history returns it after the turns sent so far. Every agent message keeps the
 * chips it was offered with, the decided consent's included, as the backend stores them.
 */
const storedMessages = (sentBodies: Array<Record<string, unknown>>) => {
  const createdAt = new Date().toISOString();
  return [
    { id: "visitor-1", role: "user", content: FIRST_MESSAGE, createdAt },
    { id: PROMPT_ID, role: "assistant", content: WORDING, createdAt, suggestions: CONSENT_CHIPS },
    ...(sentBodies.length > 1
      ? [
          { id: "visitor-2", role: "user", content: sentBodies[1].message, createdAt, inputMetadata: sentBodies[1].inputMetadata },
          { id: NEXT_STEP_ID, role: "assistant", content: NEXT_STEP, createdAt },
        ]
      : []),
  ];
};

/**
 * The agent's turns: the first message reaches the consent, the next one goes on to the covered
 * step. A reload finds the conversation and reads it back from history.
 */
const mockChat = async (page: Page, sentBodies: Array<Record<string, unknown>>) => {
  await page.route("**/backend/api/v1/**", (route) => route.fulfill({ status: 204, body: "" }));
  // Before the first turn there is no conversation to find, so the list gets the empty answer above.
  await page.route((url) => url.pathname === `/backend/api/v1/public/chat/${TOKEN}`, (route) =>
    sentBodies.length === 0
      ? route.fallback()
      : fulfillJson(route, { workspaceName: "Acme Classes", conversations: [{ id: CONVERSATION_ID }] }));
  await page.route((url) => url.pathname === `/backend/api/v1/public/chat/${TOKEN}/history/${CONVERSATION_ID}`, (route) =>
    fulfillJson(route, {
      conversationId: CONVERSATION_ID,
      messages: storedMessages(sentBodies),
      hasOlderMessages: false,
      nextCursor: null,
      tailCursor: null,
    }));
  await page.route("**/api/embed/config/**", (route) => fulfillJson(route, {}));
  await page.route("**/api/embed/session/**", (route) => fulfillJson(route, bootstrapSessionPayload()));
  await page.route(`**/api/public/chat/${TOKEN}`, async (route) => {
    sentBodies.push(route.request().postDataJSON() as Record<string, unknown>);
    const done = sentBodies.length === 1
      ? { assistantMessageId: PROMPT_ID, answer: WORDING, suggestions: CONSENT_CHIPS }
      : { assistantMessageId: NEXT_STEP_ID, answer: NEXT_STEP };
    await route.fulfill({ status: 200, contentType: "text/event-stream", body: streamedTurn(done) });
  });
};

/**
 * The launcher on a host page that stands in for a customer's site, on another origin than the app
 * host that serves the launcher script and the chat frame, as on a real site.
 */
const openEmbed = async (page: Page) => {
  await page.route((url) => url.pathname === "/embed-test", async (route) => {
    const response = await route.fetch();
    const headers = Object.fromEntries(Object.entries(response.headers())
      .filter(([name]) => name !== "content-security-policy" && name !== "permissions-policy"));
    await route.fulfill({ response, headers });
  });
  const host = new URL(test.info().project.use.baseURL!);
  const appHost = new URL(host);
  appHost.hostname = "localhost";
  await page.goto(`${host.origin}/embed-test?token=${TOKEN}&appOrigin=${encodeURIComponent(appHost.origin)}`);
  return openChatFrame(page);
};

const openChatFrame = async (page: Page) => {
  await page.locator(".radioso-launcher").click();
  const frame = page.frameLocator('iframe[src*="/embed-frame"]');
  await expect(frame.getByRole("textbox")).toBeVisible();
  return frame;
};

test("a visitor sees the consent wording with its two buttons, and agreeing sends the chip and the message it came with", async ({ page }) => {
  const sentBodies: Array<Record<string, unknown>> = [];
  await mockChat(page, sentBodies);
  const frame = await openEmbed(page);

  await frame.getByRole("textbox").fill(FIRST_MESSAGE);
  await frame.getByRole("button", { name: "Send message" }).click();

  // The wording exactly as the operator wrote it, and the two labels as buttons.
  await expect(frame.getByText(WORDING, { exact: true })).toBeVisible();
  const agree = frame.getByRole("button", { name: "I agree", exact: true });
  await expect(agree).toBeVisible();
  await expect(frame.getByRole("button", { name: "No thanks", exact: true })).toBeVisible();

  await agree.click();

  await expect(frame.getByText(NEXT_STEP)).toBeVisible();
  expect(sentBodies).toHaveLength(2);
  expect(sentBodies[1]).toMatchObject({
    message: "I agree",
    conversationId: CONVERSATION_ID,
    inputMetadata: { method: "suggestion_click", suggestionSourceMessageId: PROMPT_ID, suggestionId: "agree" },
  });
});

test("a reload keeps the buttons on a consent still waiting for an answer, and brings none back once it is decided", async ({ page }) => {
  const sentBodies: Array<Record<string, unknown>> = [];
  await mockChat(page, sentBodies);
  let frame = await openEmbed(page);

  await frame.getByRole("textbox").fill(FIRST_MESSAGE);
  await frame.getByRole("button", { name: "Send message" }).click();
  await expect(frame.getByRole("button", { name: "I agree", exact: true })).toBeVisible();

  // Reloaded before answering, the consent still asks.
  await page.reload();
  frame = await openChatFrame(page);
  await expect(frame.getByText(WORDING, { exact: true })).toBeVisible();
  await frame.getByRole("button", { name: "I agree", exact: true }).click();
  await expect(frame.getByText(NEXT_STEP)).toBeVisible();
  expect(sentBodies[1]).toMatchObject({ inputMetadata: { suggestionId: "agree", suggestionSourceMessageId: PROMPT_ID } });

  // Reloaded after the decision, the wording stays in the thread and its buttons do not come back.
  await page.reload();
  frame = await openChatFrame(page);
  await expect(frame.getByText(NEXT_STEP)).toBeVisible();
  await expect(frame.getByText(WORDING, { exact: true })).toBeVisible();
  await expect(frame.getByRole("button", { name: "I agree", exact: true })).toHaveCount(0);
  await expect(frame.getByRole("button", { name: "No thanks", exact: true })).toHaveCount(0);
  expect(sentBodies).toHaveLength(2);
});
