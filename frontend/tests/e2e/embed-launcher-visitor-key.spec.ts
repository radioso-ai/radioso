import { expect, test, type Page, type Route } from "@playwright/test";

// FR-008/FR-009 (spec 1277 decision 6): the embed launcher mints a durable
// visitor-grouping key client-side (crypto.randomUUID()) on first visit,
// persists it in host-page localStorage (scoped by embed token), and resends
// it on every bootstrap — including from a brand-new tab, which has no
// sessionStorage resume token yet. The key is never server-assigned and never
// a session credential; the backend does not echo it back. This drives the
// real launcher script (frontend/lib/radioso-embed-launcher.js) through two
// pages of the same browser context (same origin, so localStorage is
// genuinely shared, like two real tabs), mocking only the network boundary.

const TOKEN = "e2e-visitor-key-token";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  publicSessionId: "11111111-1111-4111-8111-111111111111",
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

test("the embed launcher sends the same client-generated visitorKey from a brand-new tab", async ({ context }) => {
  const bootstrapRequestBodies: Array<Record<string, unknown>> = [];

  const firstTab = await context.newPage();
  await openEmbedAndCaptureBootstrap(firstTab, bootstrapRequestBodies);
  await expect.poll(() => bootstrapRequestBodies.length).toBeGreaterThanOrEqual(1);

  const firstVisitorKey = bootstrapRequestBodies[0]?.visitorKey;
  expect(typeof firstVisitorKey).toBe("string");
  expect(firstVisitorKey as string).toMatch(UUID_PATTERN);

  // A brand-new tab has no sessionStorage resume token (that storage is
  // per-tab by design) — before FR-008 this bootstrap would have carried no
  // visitorKey at all. It must carry the SAME key as the first tab, read back
  // from localStorage, not a freshly minted one.
  const secondTab = await context.newPage();
  await openEmbedAndCaptureBootstrap(secondTab, bootstrapRequestBodies);
  await expect.poll(() => bootstrapRequestBodies.length).toBeGreaterThanOrEqual(2);

  expect(bootstrapRequestBodies[1]?.visitorKey).toBe(firstVisitorKey);

  await firstTab.close();
  await secondTab.close();
});

test("the embed launcher still bootstraps with no visitorKey and no console error when localStorage throws (FR-009)", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });

  // The embed-test host page's own app shell makes unrelated backend-proxy calls
  // (session check, analytics beacons) that 503 in this backend-less e2e harness
  // regardless of the launcher's storage behaviour; stub them so the console-error
  // assertion below reflects only the launcher under test, not harness noise.
  await page.route("**/backend/api/v1/**", (route) => route.fulfill({ status: 204, body: "" }));

  // Simulates privacy mode / a sandboxed iframe / storage disabled: any access to
  // `window.localStorage` throws a SecurityError, before the launcher script runs.
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    });
  });

  const bootstrapRequestBodies: Array<Record<string, unknown>> = [];
  await openEmbedAndCaptureBootstrap(page, bootstrapRequestBodies);
  await expect.poll(() => bootstrapRequestBodies.length).toBeGreaterThanOrEqual(1);

  expect(bootstrapRequestBodies[0]).not.toHaveProperty("visitorKey");
  expect(consoleErrors).toEqual([]);
});
