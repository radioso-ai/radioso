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

const openEmbed = async (page: Page, session: { acceptsImages?: boolean }, options: { talk?: boolean } = {}) => {
  await page.route("**/api/embed/config/**", (route) => fulfillJson(route, options.talk ? { voice: { available: true } } : {}));
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

  // A file dropped anywhere in the widget's own document is not opened by the browser.
  const chatFrame = page.frames().find((candidate) => candidate.url().includes("/embed-frame"));
  const dropCancelled = await chatFrame!.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array([1])], "photo.jpg", { type: "image/jpeg" }));
    const drop = new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true });
    document.body.dispatchEvent(drop);
    return drop.defaultPrevented;
  });
  expect(dropCancelled).toBe(true);
});

test("the attach control sits beside Send, ahead of Talk, and all three fit a 360 px phone", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  const frame = await openEmbed(page, { acceptsImages: true }, { talk: true });
  const field = frame.getByRole("textbox");
  const attach = frame.getByRole("button", { name: "Attach photo" });
  const talk = frame.getByRole("button", { name: "Talk" });
  const send = frame.getByRole("button", { name: "Send message" });
  await field.fill("Do you open on Sundays?");

  // Tabbing from the message field reaches the attach control, then Talk, then Send.
  await field.focus();
  await page.keyboard.press("Tab");
  await expect(attach).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(talk).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(send).toBeFocused();

  // On screen they are one row to the right of the field with nothing overlapping, each a 36 px target,
  // and the field keeps room to type in. The panel eases in as it opens, so measure once it is full size.
  await expect.poll(async () => (await send.boundingBox())!.width).toBeGreaterThanOrEqual(36);
  const [fieldBox, attachBox, talkBox, sendBox] = await Promise.all([field, attach, talk, send].map((target) => target.boundingBox()));
  expect(attachBox!.x).toBeGreaterThanOrEqual(fieldBox!.x + fieldBox!.width - 1);
  expect(attachBox!.x + attachBox!.width).toBeLessThanOrEqual(talkBox!.x);
  expect(talkBox!.x + talkBox!.width).toBeLessThanOrEqual(sendBox!.x);
  expect(sendBox!.x + sendBox!.width).toBeLessThanOrEqual(360);
  for (const box of [attachBox!, talkBox!, sendBox!]) {
    expect(box.width).toBeGreaterThanOrEqual(36);
    expect(box.height).toBeGreaterThanOrEqual(36);
  }
  expect(fieldBox!.width).toBeGreaterThanOrEqual(150);
});

test("the website widget offers no attach control when the agent takes no photos", async ({ page }) => {
  const frame = await openEmbed(page, { acceptsImages: false });

  await expect(frame.getByRole("button", { name: "Send message" })).toBeVisible();
  await expect(frame.getByRole("button", { name: "Attach photo" })).toHaveCount(0);
});
