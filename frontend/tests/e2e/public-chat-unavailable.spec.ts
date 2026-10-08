import { expect, test, type Page } from "@playwright/test";

// No pre-existing spec exercises the standalone `/chat/[token]` send-failure path (the one
// close analog, greeting-exact-words.spec.ts, only covers the bootstrap greeting). This
// mocks `/backend/api/v1/public/chat/:token` (session exchange + conversation list) and the
// Next.js streaming proxy route directly, the same two-route pattern that spec uses.

const publicToken = "public-token-usage-limit";

const mockSessionAndConversationList = async (page: Page) => {
  await page.route(`**/backend/api/v1/public/chat/${publicToken}**`, async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;

    if (pathname.endsWith("/sessions") && request.method() === "POST") {
      await route.fulfill({
        json: {
          agentId: "67acb0c8-caad-4a1b-9fef-70cbca3f7d12",
          agentName: "Marta",
          assistantLinkUtmEnabled: true,
          workspaceName: "Acme",
          publicChatToken: publicToken,
          publicSessionId: "11111111-1111-4111-8111-111111111111",
          publicSessionToken: "public-session-token",
          resumeToken: "resume-token",
          assistantBootstrapActive: false,
          assistantAvatarUrl: null,
          theme: { brand: "#0f172a", brandText: "#f8fafc", surface: "#ffffff", text: "#0f172a" },
          branding: { hidePoweredBy: false, privacyPolicyUrl: null },
          intakeActions: [],
        },
      });
      return;
    }

    if (request.method() === "GET") {
      // No greeting and no history, so the test can go straight to sending a message
      // without the bootstrap-greeting request in the way.
      await route.fulfill({
        json: {
          workspaceName: "Acme",
          assistantAvatarUrl: null,
          assistantLinkUtmEnabled: true,
          citationDisplayEnabled: true,
          theme: { brand: "#0f172a", brandText: "#f8fafc", surface: "#ffffff", text: "#0f172a" },
          branding: { hidePoweredBy: false, privacyPolicyUrl: null },
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
};

const mockUsageLimitExceeded = async (page: Page) => {
  await page.route(`**/api/public/chat/${publicToken}`, async (route) => {
    await route.fulfill({
      status: 429,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "usage_limit_exceeded", message: "Usage limit exceeded" } }),
    });
  });
};

test("shows the agent-unavailable message (not the generic failure) when the account's quota is exhausted, and keeps the composer usable", async ({ page }) => {
  await mockSessionAndConversationList(page);
  await mockUsageLimitExceeded(page);

  await page.goto(`/chat/${publicToken}`);

  const composer = page.getByPlaceholder("Ask a question...");
  await composer.fill("Is anyone there?");
  await page.getByRole("button", { name: "Send message" }).click();

  await expect(page.getByText("This assistant isn't available right now. Please try again later.")).toBeVisible();
  // The generic failure copy is a different string the view falls back to for every
  // other error — it must not appear for this one.
  await expect(page.getByText("Sorry, something went wrong. Please try again.")).toHaveCount(0);

  // Quota can be restored at any time, so unlike the permanent "chat link deactivated"
  // takeover, the composer stays enabled rather than locking the visitor out. The send
  // button is disabled on empty input regardless of failure state, so type something
  // to prove the whole path still works, not just that the input accepts focus.
  await expect(composer).toBeEditable();
  await composer.fill("Still there?");
  await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
});

test("renders the agent-unavailable message in the visitor's locale", async ({ page }) => {
  await mockSessionAndConversationList(page);
  await mockUsageLimitExceeded(page);

  await page.goto(`/chat/${publicToken}?locale=fr`);

  const composer = page.getByPlaceholder("Posez une question...");
  await composer.fill("Il y a quelqu'un ?");
  await page.getByRole("button", { name: "Envoyer le message" }).click();

  await expect(
    page.getByText("Cet assistant n'est pas disponible pour le moment. Veuillez réessayer plus tard."),
  ).toBeVisible();
});
