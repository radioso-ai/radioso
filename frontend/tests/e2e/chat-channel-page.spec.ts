import { expect, test } from "@playwright/test";

import {
  basePlatformSettings,
  defaultAgentId,
  installDashboardApiMocks,
  seedDashboardStorage,
  workspaceKey,
} from "./dashboard-fixtures";

const webChatUrl = `/w/${workspaceKey}/agents/${defaultAgentId}?tab=channels&anchor=web-chat`;

test("operator configures one chat surface for both placements", async ({ page }) => {
  const agentUpdates: unknown[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    platformSettings: basePlatformSettings(),
    agentUpdates,
  });

  await page.goto(webChatUrl);

  // Look, wording and placement all live on the one page now.
  await expect(page.getByRole("heading", { name: "Web chat", level: 1, exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Look", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Wording", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Where it runs", exact: true })).toBeVisible();
  await expect(page.getByLabel("Assistant preview")).toBeVisible();

  // Wording stays out of the way until asked for, and says whether anything is customized.
  const startPrompt = page.locator("#websiteEmbedCopy-startPrompt");
  await expect(startPrompt).toBeHidden();
  await expect(page.getByText("Using the built-in wording.")).toBeVisible();

  // Opening it edits the base wording directly, with no language code to pick first.
  await page.getByRole("button", { name: "Edit wording" }).click();
  await expect(startPrompt).toBeVisible();
  await expect(page.getByLabel("Language code")).toHaveCount(0);
  await startPrompt.fill("Ask us anything");

  await expect
    .poll(() =>
      agentUpdates.some(
        (update) =>
          (update as { surfaceSettings?: { websiteEmbed?: { copy?: Record<string, { startPrompt?: string }> } } })
            .surfaceSettings?.websiteEmbed?.copy?.en?.startPrompt === "Ask us anything",
      ),
    )
    .toBe(true);

  // The saved value survives a reload rather than only living in local state.
  await page.reload();
  await expect(page.getByText("1 of 11 phrases customized.")).toBeVisible();
  await page.getByRole("button", { name: "Edit wording" }).click();
  await expect(page.locator("#websiteEmbedCopy-startPrompt")).toHaveValue("Ask us anything");

  // Both placements can be turned on from the same page.
  await page.locator("#anonChatToggle").click();
  await expect
    .poll(() =>
      agentUpdates.some(
        (update) =>
          (update as { surfaceSettings?: { anonymousChat?: { enabled?: boolean } } }).surfaceSettings?.anonymousChat
            ?.enabled === true,
      ),
    )
    .toBe(true);
  await expect(page.getByRole("heading", { name: "Public link", exact: true })).toBeVisible();

  await page.locator("#websiteEmbedToggle").click();
  await expect
    .poll(() =>
      agentUpdates.some(
        (update) =>
          (update as { surfaceSettings?: { websiteEmbed?: { enabled?: boolean } } }).surfaceSettings?.websiteEmbed
            ?.enabled === true,
      ),
    )
    .toBe(true);
  await expect(page.getByRole("heading", { name: "Website widget", exact: true })).toBeVisible();
});

test("operator changes the shared chat color without resubmitting unrelated behavior", async ({ page }) => {
  const agentUpdates: unknown[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    platformSettings: basePlatformSettings(),
    agentUpdates,
  });

  await page.goto(webChatUrl);
  await page.locator("#assistantTheme-brand").fill("#0d3fb5");

  await expect.poll(() =>
    agentUpdates.find((update) => (update as { theme?: { brand?: string } }).theme?.brand === "#0d3fb5"),
  ).toEqual({
    theme: {
      brand: "#0d3fb5",
      brandText: "#ffffff",
      surface: "#ffffff",
      text: "#0f172a",
    },
  });
});

test("the retired website-embed anchor still lands on the merged chat page", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    platformSettings: basePlatformSettings(),
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=channels&anchor=website-embed`);

  await expect(page.getByRole("heading", { name: "Web chat", level: 1, exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Wording", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Website widget", exact: true })).toBeVisible();
});

test("operator reveals the translation editor only on demand", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    platformSettings: basePlatformSettings(),
  });

  await page.goto(webChatUrl);

  await expect(page.getByRole("heading", { name: "Translations", exact: true })).toBeHidden();

  await page.getByRole("button", { name: "Edit wording" }).click();
  await expect(page.getByRole("heading", { name: "Translations", exact: true })).toBeVisible();
  await expect(page.getByLabel("Language code")).toHaveCount(0);

  await page.getByRole("button", { name: "Add a translation" }).click();
  await expect(page.getByLabel("Language code")).toBeVisible();
});
