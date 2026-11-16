import { expect, test, type Route } from "@playwright/test";

// The chat frame is a server-rendered page, and a host site hosts the launcher
// on every page, so a page view renders only the launcher: the frame loads on
// the visitor's first intent, and the session still waits for the open. This
// drives the real launcher script, mocking only the network boundary.

const TOKEN = "e2e-frame-on-intent-token";

const readyIframeHtml =
  "<!doctype html><script>window.parent.postMessage({ type: 'radioso:embed:ready' }, '*')</script>";

const fulfillJson = (route: Route, body: unknown) =>
  route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

test("a host page view loads the chat frame only once the visitor points at the launcher", async ({ page }) => {
  const frameRequests: string[] = [];
  const sessionRequests: string[] = [];
  await page.route("**/api/embed/config/**", (route) => fulfillJson(route, {}));
  await page.route("**/embed-frame**", (route) => {
    frameRequests.push(route.request().url());
    return route.fulfill({ status: 200, contentType: "text/html", body: readyIframeHtml });
  });
  await page.route("**/api/embed/session/**", (route) => {
    sessionRequests.push(route.request().url());
    return fulfillJson(route, {
      workspaceName: "Acme",
      publicChatToken: TOKEN,
      publicSessionId: "11111111-1111-4111-8111-111111111111",
      publicSessionToken: "public-session-token",
      resumeToken: "resume-token",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      resumeExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
  });

  await page.goto(`/embed-test?token=${TOKEN}`);
  const launcher = page.locator(".radioso-launcher");
  await expect(launcher).toBeVisible();
  const chatFrame = page.locator('iframe[src*="/embed-frame"]');
  await expect(chatFrame).toHaveCount(0);
  expect(frameRequests).toHaveLength(0);

  await launcher.hover();
  await expect(chatFrame).toHaveCount(1);
  await expect.poll(() => frameRequests.length).toBe(1);
  expect(sessionRequests).toHaveLength(0);

  await launcher.click();
  await expect.poll(() => sessionRequests.length).toBe(1);
  expect(frameRequests).toHaveLength(1);
});
