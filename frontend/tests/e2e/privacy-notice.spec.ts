import { expect, test, type Page } from "@playwright/test";

import {
  defaultAgentId,
  installDashboardApiMocks,
  nowIso,
  seedDashboardStorage,
  workspaceId,
  workspaceKey,
} from "./dashboard-fixtures";

// The privacy notice journey (#1545): the operator writes the notice on the Web chat page, a visitor
// sees it before their first message, the message that starts the conversation reports its version,
// and the conversation's Visitor panel shows what was recorded. The backend derives the version; the
// mocks stand in with one.

const publicToken = "public-token-privacy-notice";
const noticeText = "We use your messages to answer you and keep them for 30 days.";
const policyUrl = "https://example.test/privacy";
const version = "en:5f2c9a1b7d3e8a60";
const conversationId = "conversation-privacy-notice";

const theme = { brand: "#0f172a", brandText: "#f8fafc", surface: "#ffffff", text: "#0f172a" };

/** The public chat as the backend serves it once the operator saved the notice. */
const mockPublicChat = async (page: Page, sentBodies: unknown[]) => {
  const branding = { hidePoweredBy: false, privacyPolicyUrl: null, privacyNotice: { en: { text: noticeText, url: policyUrl, version } } };
  await page.route(`**/backend/api/v1/public/chat/${publicToken}**`, async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname.endsWith("/sessions") && request.method() === "POST") {
      await route.fulfill({
        json: {
          agentId: defaultAgentId,
          agentName: "Marta",
          assistantLinkUtmEnabled: true,
          workspaceName: "Acme",
          publicChatToken: publicToken,
          publicSessionId: "11111111-1111-4111-8111-111111111111",
          publicSessionToken: "public-session-token",
          resumeToken: "resume-token",
          assistantBootstrapActive: false,
          assistantAvatarUrl: null,
          theme,
          branding,
          intakeActions: [],
        },
      });
      return;
    }
    if (request.method() === "GET") {
      await route.fulfill({
        json: {
          workspaceName: "Acme",
          assistantAvatarUrl: null,
          assistantLinkUtmEnabled: true,
          citationDisplayEnabled: true,
          theme,
          branding,
          intakeActions: [],
          assistantBootstrapActive: false,
          conversations: [],
          total: 0,
          nextCursor: null,
          hasMore: false,
        },
      });
      return;
    }
    await route.continue();
  });
  await page.route(`**/api/public/chat/${publicToken}`, async (route) => {
    sentBodies.push(JSON.parse(route.request().postData() ?? "{}"));
    const done = { conversationId, assistantMessageId: "assistant-message-1", answer: "We open at nine." };
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: [
        `event: conversation\ndata: ${JSON.stringify({ conversationId })}\n\n`,
        `event: chunk\ndata: ${JSON.stringify({ text: done.answer })}\n\n`,
        `event: done\ndata: ${JSON.stringify(done)}\n\n`,
      ].join(""),
    });
  });
};

test("a visitor sees the operator's privacy notice before their first message, and the conversation records its version", async ({ page }) => {
  const agentUpdates: unknown[] = [];
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
    preview: "When do you open?",
    title: null,
  };
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    agentUpdates,
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
        privacyNoticeVersion: version,
        visitor: { id: "22222222-2222-4222-8222-222222222222", firstSeenAt: nowIso, conversationCount: 1, verified: false },
        requestContext: null,
        messages: [
          { id: "user-message-1", role: "user" as const, source: "customer" as const, content: "When do you open?", createdAt: nowIso },
          { id: "assistant-message-1", role: "assistant" as const, source: "ai_agent" as const, content: "We open at nine.", createdAt: nowIso },
        ],
      },
    },
  });

  // The operator writes the notice: one line and a link, in English.
  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=channels&anchor=web-chat`);
  await expect(page.getByRole("heading", { name: "Privacy notice", exact: true })).toBeVisible();
  const card = page.locator("#privacy-notice");
  await card.locator("#privacyNoticeLanguage").fill("en");
  await card.getByRole("button", { name: "Add", exact: true }).click();
  await page.locator("#privacyNoticeText-en").fill(noticeText);
  await page.locator("#privacyNoticeUrl-en").fill(policyUrl);
  await expect
    .poll(() =>
      agentUpdates.some((update) => {
        const notice = (update as { branding?: { privacyNotice?: Record<string, { text?: string; url?: string }> } }).branding?.privacyNotice?.en;
        return notice?.text === noticeText && notice.url === policyUrl;
      }),
    )
    .toBe(true);

  // A visitor opens the chat: the notice is there before they type.
  const visitor = await page.context().newPage();
  const sentBodies: unknown[] = [];
  await mockPublicChat(visitor, sentBodies);
  await visitor.goto(`/chat/${publicToken}`);
  const shown = visitor.getByTestId("privacy-notice");
  await expect(shown).toContainText(noticeText);
  await expect(shown.getByRole("link", { name: "Privacy policy" })).toHaveAttribute("href", policyUrl);

  // The message that starts the conversation reports the version it showed.
  await visitor.getByPlaceholder("Ask a question...").fill("When do you open?");
  await visitor.getByRole("button", { name: "Send message" }).click();
  await expect(visitor.getByText("We open at nine.")).toBeVisible();
  expect(sentBodies[0]).toMatchObject({ message: "When do you open?", privacyNoticeVersion: version });
  // The notice stays at the top of the thread, before the visitor's message.
  await expect(visitor.getByTestId("privacy-notice")).toContainText(noticeText);
  await visitor.close();

  // The operator sees which notice the conversation's visitor was shown.
  await page.goto(`/w/${workspaceKey}/activity?tab=all`);
  await page.getByRole("button", { name: /When do you open/ }).click();
  await page.getByRole("button", { name: "Open in debug view" }).click();
  await expect(page.getByText("Privacy notice", { exact: true })).toBeVisible();
  await expect(page.getByText(version)).toBeVisible();
});
