import { expect, test, type Page, type Route } from "@playwright/test";

// The chat frame runs on a customer's site as a third-party iframe, for visitors who have no
// operator session. Browsers that block third-party storage throw SecurityError on any read of
// `localStorage` or `sessionStorage` there, so the frame must not run operator-session code
// that reads them, nor ask the app for an operator session.

const TOKEN = "e2e-visitor-surface-token";

test.use({
  launchOptions: {
    // The host page is served through the test's route, which Chromium treats as a public
    // address; it would otherwise refuse that page the app host on the loopback address.
    args: ["--disable-features=LocalNetworkAccessChecks"],
  },
});

const fulfillJson = (route: Route, body: unknown) =>
  route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

const bootstrapSessionPayload = () => ({
  workspaceName: "Acme",
  agentId: "agent-1",
  agentName: "Support",
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

/** Records, inside the chat frame, every error the page leaves unhandled. */
const recordFrameErrors = async (page: Page) => {
  await page.addInitScript(() => {
    if (window.location.pathname !== "/embed-frame") return;
    const recorded: string[] = [];
    Object.defineProperty(window, "__unhandledErrors", { value: recorded });
    window.addEventListener("error", (event) => recorded.push(String(event.error ?? event.message)));
    window.addEventListener("unhandledrejection", (event) => {
      const reason: unknown = event.reason;
      recorded.push(reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason));
    });
  });
};

/** Makes the chat frame behave as a browser that blocks third-party storage. */
const blockFrameStorage = async (page: Page) => {
  await page.addInitScript(() => {
    if (window.location.pathname !== "/embed-frame") return;
    for (const name of ["localStorage", "sessionStorage"]) {
      Object.defineProperty(window, name, {
        configurable: true,
        get() {
          throw new DOMException(`Failed to read the '${name}' property from 'Window': Access is denied for this document.`, "SecurityError");
        },
      });
    }
  });
};

const openChat = async (page: Page) => {
  const operatorSessionRequests: string[] = [];
  await page.route("**/backend/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const fromChatFrame = route.request().frame().url().includes("/embed-frame");
    if (fromChatFrame && url.pathname.endsWith("/auth/session")) operatorSessionRequests.push(url.pathname);
    await route.fulfill({ status: 204, body: "" });
  });
  await page.route("**/api/embed/config/**", (route) => fulfillJson(route, {}));
  await page.route("**/api/embed/session/**", (route) => fulfillJson(route, bootstrapSessionPayload()));
  const sentMessages: Array<{ headers: Record<string, string>; body: unknown }> = [];
  await page.route(`**/api/public/chat/${TOKEN}`, async (route) => {
    sentMessages.push({ headers: route.request().headers(), body: route.request().postDataJSON() });
    const done = { conversationId: "conversation-1", assistantMessageId: "assistant-message-1", answer: "We open at nine." };
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: [
        `event: conversation\ndata: ${JSON.stringify({ conversationId: done.conversationId })}\n\n`,
        `event: chunk\ndata: ${JSON.stringify({ text: done.answer })}\n\n`,
        `event: done\ndata: ${JSON.stringify(done)}\n\n`,
      ].join(""),
    });
  });

  // The host page stands in for a customer's site, which is not served with the app's own
  // script policy that would refuse the app host's launcher.
  await page.route((url) => url.pathname === "/embed-test", async (route) => {
    const response = await route.fetch();
    const headers = Object.fromEntries(Object.entries(response.headers())
      .filter(([name]) => name !== "content-security-policy"));
    await route.fulfill({ response, headers });
  });

  // The host page and the app host are two origins, as a customer's site and the app host are.
  const host = new URL(test.info().project.use.baseURL!);
  const appHost = new URL(host);
  appHost.hostname = "localhost";
  await page.goto(`${host.origin}/embed-test?token=${TOKEN}&appOrigin=${encodeURIComponent(appHost.origin)}`);
  await page.locator(".radioso-launcher").click();
  const frame = page.frameLocator('iframe[src*="/embed-frame"]');
  await expect(frame.getByRole("textbox")).toBeVisible();

  const chatFrame = page.frames().find((candidate) => candidate.url().includes("/embed-frame"));
  if (!chatFrame) throw new Error("The chat frame is not on the page");
  const unhandledErrors = () => chatFrame.evaluate(() =>
    (window as unknown as { __unhandledErrors: string[] }).__unhandledErrors);
  return { frame, operatorSessionRequests, sentMessages, unhandledErrors };
};

test("a visitor whose browser blocks third-party storage chats with no error in the frame", async ({ page }) => {
  await recordFrameErrors(page);
  await blockFrameStorage(page);

  const { frame, sentMessages, unhandledErrors } = await openChat(page);
  await frame.getByRole("textbox").fill("When do you open?");
  await frame.getByRole("button", { name: "Send message" }).click();

  await expect(frame.getByText("We open at nine.")).toBeVisible();
  expect(sentMessages).toHaveLength(1);
  expect(sentMessages[0].body).toMatchObject({ message: "When do you open?" });
  // The session the launcher handed over, kept in memory, still identifies the visitor.
  expect(sentMessages[0].headers["x-radioso-public-session"]).toBe("public-session-token");
  expect(sentMessages[0].headers["x-radioso-anonymous-session"]).toBe("11111111-1111-4111-8111-111111111111");
  expect(await unhandledErrors()).toEqual([]);
});

test("the chat frame never asks the app for an operator session", async ({ page }) => {
  await recordFrameErrors(page);

  const { operatorSessionRequests, unhandledErrors } = await openChat(page);

  expect(operatorSessionRequests).toEqual([]);
  expect(await unhandledErrors()).toEqual([]);
});
