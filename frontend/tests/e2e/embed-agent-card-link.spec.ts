import { expect, test, type Route } from "@playwright/test";

// FR-023 (spec 1290): a crawler-style agent reads the host page rather than running the
// widget, so the launcher advertises the agent's card during bootstrap. The link appears
// only when the embed config carries a card URL — an agent that publishes no card must not
// have a link pointing at a 404.

const TOKEN = "e2e-agent-card-token";
const CARD_URL = "https://api.radioso.test/.well-known/agent-card/ag_QmFzZTY0dXJsSWRlbnQxMg.json";

const readyIframeHtml =
  "<!doctype html><script>window.parent.postMessage({ type: 'radioso:embed:ready' }, '*')</script>";

const fulfillJson = (route: Route, body: unknown) =>
  route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

const openEmbed = async (page: import("@playwright/test").Page, config: Record<string, unknown>) => {
  await page.route("**/api/embed/config/**", (route) => fulfillJson(route, config));
  await page.route("**/embed-frame**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: readyIframeHtml }));

  await page.goto(`/embed-test?token=${TOKEN}`);
  await page.locator(".radioso-launcher").waitFor();
};

test("the launcher links the page to the agent card when the agent publishes one", async ({ page }) => {
  await openEmbed(page, { agentCardUrl: CARD_URL });

  const link = page.locator('link[rel="agent-card"]');
  await expect(link).toHaveAttribute("href", CARD_URL);
  await expect(link).toHaveAttribute("type", "application/json");
  await expect(link).toHaveCount(1);
});

test("the launcher adds no link when the agent publishes no card", async ({ page }) => {
  await openEmbed(page, {});

  await expect(page.locator('link[rel="agent-card"]')).toHaveCount(0);
});
