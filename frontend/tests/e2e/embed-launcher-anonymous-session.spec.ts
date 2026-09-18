import { expect, test, type Page, type Route } from "@playwright/test";

// FR-008/FR-009 (spec 1277): the embed launcher persists the anonymous
// session id the backend hands back at bootstrap in host-page localStorage
// (scoped by embed token), and resends it on the next bootstrap so a brand
// new tab — which has no sessionStorage resume token yet — still links to
// the same visitor. This drives the real launcher script
// (frontend/lib/radioso-embed-launcher.js) through two pages of the same
// browser context (same origin, so localStorage is genuinely shared, like
// two real tabs), mocking only the network boundary.

const TOKEN = "e2e-anon-session-token";
const FIRST_ANONYMOUS_SESSION_ID = "11111111-1111-4111-8111-111111111111";

const readyIframeHtml =
  "<!doctype html><script>window.parent.postMessage({ type: 'radioso:embed:ready' }, '*')</script>";

const fulfillJson = (route: Route, body: unknown) =>
  route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

const bootstrapSessionPayload = () => ({
  workspaceName: "Acme",
  agentId: "agent-1",
  agentName: "Support",
  assistantLinkUtmEnabled: false,
  citationDisplayEnabled: true,
  publicChatToken: TOKEN,
  publicSessionId: FIRST_ANONYMOUS_SESSION_ID,
  anonymousSessionId: FIRST_ANONYMOUS_SESSION_ID,
  publicSessionToken: "public-session-token",
  resumeToken: "resume-token",
  assistantBootstrapActive: false,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  resumeExpiresAt: new Date(Date.now() + 60_000).toISOString(),
});

const openEmbedAndCaptureBootstrap = async (
  page: Page,
  bootstrapRequestBodies: Array<Record<string, unknown>>,
) => {
  await page.route("**/api/embed/config/**", (route) => fulfillJson(route, {}));
  await page.route("**/embed-frame**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: readyIframeHtml }));
  await page.route("**/api/embed/session/**", async (route) => {
    const body = (route.request().postDataJSON() as Record<string, unknown> | null) ?? {};
    bootstrapRequestBodies.push(body);
    await fulfillJson(route, bootstrapSessionPayload());
  });

  await page.goto(`/embed-test?token=${TOKEN}`);
  await page.locator(".radioso-launcher").click();
};

test("the embed launcher resends the first tab's anonymous session id from a brand-new tab", async ({ context }) => {
  const bootstrapRequestBodies: Array<Record<string, unknown>> = [];

  const firstTab = await context.newPage();
  await openEmbedAndCaptureBootstrap(firstTab, bootstrapRequestBodies);
  await expect.poll(() => bootstrapRequestBodies.length).toBeGreaterThanOrEqual(1);

  // A brand-new tab has no sessionStorage resume token (that storage is
  // per-tab by design), so before FR-008 this bootstrap would have carried no
  // anonymousSessionId at all.
  const secondTab = await context.newPage();
  await openEmbedAndCaptureBootstrap(secondTab, bootstrapRequestBodies);
  await expect.poll(() => bootstrapRequestBodies.length).toBeGreaterThanOrEqual(2);

  expect(bootstrapRequestBodies[0]?.anonymousSessionId).toBeUndefined();
  expect(bootstrapRequestBodies[1]?.anonymousSessionId).toBe(FIRST_ANONYMOUS_SESSION_ID);

  await firstTab.close();
  await secondTab.close();
});
