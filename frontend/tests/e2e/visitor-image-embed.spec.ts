import { expect, test, type Page, type Route } from "@playwright/test";

// The website embed offers the attach control only when the conversation list the chat reads says the
// agent takes photos. The launcher and the chat frame are the real ones, with the host page on
// 127.0.0.1 and the app host on localhost so the frame is cross-origin as on a customer's site, and
// the network mocked at its edges.

const TOKEN = "e2e-image-embed-token";

test.use({
  launchOptions: {
    // The host page is served through the test's route, which Chromium treats as a public address; it
    // would otherwise refuse that page the app host on the loopback address.
    args: ["--disable-features=LocalNetworkAccessChecks"],
  },
});

const fulfillJson = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const openEmbed = async (page: Page, session: { acceptsImages?: boolean }) => {
  await page.route("**/api/embed/config/**", (route) => fulfillJson(route, {}));
  await page.route("**/api/embed/session/**", (route) =>
    fulfillJson(route, {
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
      ...session,
    }));
  // The chat reads whether the agent takes photos from its conversation list, as a reload does.
  await page.route(`**/backend/api/v1/public/chat/${TOKEN}**`, (route) =>
    fulfillJson(route, {
      acceptsImages: session.acceptsImages ?? false,
      workspaceName: "Acme",
      assistantAvatarUrl: null,
      assistantLinkUtmEnabled: false,
      citationDisplayEnabled: true,
      intakeActions: [],
      assistantBootstrapActive: false,
      conversations: [],
      total: 0,
      nextCursor: null,
      hasMore: false,
    }));

  // The host page stands in for a customer's site, which is not served with the app's own security headers.
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
  await page.locator(".radioso-launcher").click();
  const frame = page.frameLocator('iframe[src*="/embed-frame"]');
  await expect(frame.getByRole("textbox")).toBeVisible();
  return frame;
};

test("the website widget offers the attach control when the agent takes photos", async ({ page }) => {
  const frame = await openEmbed(page, { acceptsImages: true });

  await expect(frame.getByRole("button", { name: "Attach photo" })).toBeVisible();
  await frame.getByTestId("visitor-image-input").setInputFiles({ name: "farmhouse.jpg", mimeType: "image/jpeg", buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) });
  // The preview chip shows in the widget; the upload itself has no mock here and fails, which the chip says.
  await expect(frame.locator("[data-attachment-status]")).toHaveCount(1);
});

test("the website widget offers no attach control when the agent takes no photos", async ({ page }) => {
  const frame = await openEmbed(page, { acceptsImages: false });

  await expect(frame.getByRole("button", { name: "Send message" })).toBeVisible();
  await expect(frame.getByRole("button", { name: "Attach photo" })).toHaveCount(0);
});
