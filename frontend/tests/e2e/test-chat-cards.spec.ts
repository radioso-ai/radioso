import { expect, test } from "@playwright/test";

import {
  defaultAgentId,
  installDashboardApiMocks,
  seedDashboardStorage,
  testExecutionFixtureId,
  workspaceKey,
} from "./dashboard-fixtures";

// Test Chat's cards journey: an operator asks the draft something a bound skill answers with
// records, and the reply shows the matching ones as cards under its lead, each opening its own
// page, as a visitor's chat would. The backend is mocked at the test's message stream; the cards'
// pictures are served by a mocked image route. Every listing is invented, on `.example` domains.

const testChatUrl = `/w/${workspaceKey}/agents/${defaultAgentId}?tab=chat`;
const executionId = testExecutionFixtureId(1);
const lead = "Two flats in Mitte fit your budget.";
const imageBase = "https://api.example/api/v1/public/reply-images";

const card = (key: string, title: string, slug: string, imageId: string) => ({
  key,
  title,
  description: "Mitte",
  image: { src: `${imageBase}/${imageId}/640`, srcSet: `${imageBase}/${imageId}/320 320w, ${imageBase}/${imageId}/640 640w`, width: 640, height: 480, alt: title },
  actions: [{ type: "open", url: `https://homes.example/listings/${slug}` }],
});

const block = {
  type: "item_list",
  id: "b1",
  layout: "carousel",
  selection: "none",
  caption: "Flats in Mitte",
  items: [
    card("/structuredContent/0", "Loft on Torstrasse", "loft-torstrasse", "0f6c1e2a-3b4d-4e5f-8a9b-0c1d2e3f4a5b"),
    card("/structuredContent/2", "Garden flat on Linienstrasse", "garden-flat-linienstrasse", "1a7d2f3b-4c5e-4f60-9b0c-1d2e3f4a5b6c"),
  ],
};

test("an operator sees a skill's records as cards under the reply in Test Chat", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);
  const pictures: string[] = [];
  await page.route(/https:\/\/api\.example\/api\/v1\/public\/reply-images\/.+/, async (route) => {
    pictures.push(route.request().url());
    // A 1x1 WebP: the route serves the copy Radioso made of the listing's photo.
    await route.fulfill({ status: 200, contentType: "image/webp", body: Buffer.from("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==", "base64") });
  });
  await page.route(/\/backend\/api\/v1\/agents\/[^/]+\/test-executions\/[^/]+\/messages$/, async (route) => {
    const body = route.request().postDataJSON() as { turnId: string; attemptId: string };
    const identity = { executionId, generation: 1, sideId: "side-1-0", turnId: body.turnId, attemptId: body.attemptId };
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: [
        { type: "side_started", ...identity },
        { type: "message_delta", ...identity, delta: lead },
        { type: "side_completed", ...identity, messageId: "message-1", answer: lead, blocks: [block] },
        { type: "execution_completed", executionId, generation: 1, turnId: body.turnId, attemptId: body.attemptId },
      ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    });
  });

  await page.goto(testChatUrl);
  await page.getByPlaceholder("Ask a question...").fill("Do you have flats in Mitte under 2,000 a month?");
  await page.getByRole("button", { name: "Send", exact: true }).click();

  await expect(page.getByText(lead).first()).toBeVisible();
  const cards = page.getByRole("list", { name: "Flats in Mitte" });
  await expect(cards.getByRole("listitem")).toHaveCount(2);
  await expect(cards.getByRole("img", { name: "Loft on Torstrasse" })).toBeVisible();
  // The card links to the listing's own page, with the chat's usual link tagging.
  await expect(cards.getByRole("link", { name: "Garden flat on Linienstrasse" })).toHaveAttribute("href", /^https:\/\/homes\.example\/listings\/garden-flat-linienstrasse(\?|$)/);
  expect(pictures.length).toBeGreaterThan(0);
});
