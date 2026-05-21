import { expect, test } from "@playwright/test";

import {
  basePlatformSettings,
  installDashboardApiMocks,
  seedDashboardStorage,
  workspaceKey,
} from "./dashboard-fixtures";

test("workspace operator stores a Claude key and picks Claude as the chat model", async ({ page }) => {
  const providerCredentialUpdates: Array<{ method: "PUT" | "DELETE"; provider: string; body?: unknown }> = [];
  const llmModelUpdates: Array<unknown> = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    platformSettings: basePlatformSettings(),
    providerCredentialUpdates,
    llmModelUpdates,
  });

  await page.goto(`/w/${workspaceKey}/settings?tab=providers`);

  // The Providers tab loads the credentials card and the models card.
  await expect(page.getByRole("heading", { name: "Provider API keys" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Models" })).toBeVisible();

  // Reveal Claude's key input, paste a key, save.
  const claudeRow = page.locator("li", { hasText: "Anthropic Claude" });
  await claudeRow.getByRole("button", { name: "Set key" }).click();
  await claudeRow.getByPlaceholder("Anthropic Claude API key").fill("  sk-ant-abc123  ");
  await claudeRow.getByRole("button", { name: "Save" }).click();

  await expect.poll(() => providerCredentialUpdates.length).toBeGreaterThanOrEqual(1);
  // The panel trims surrounding whitespace before sending (matches the backend
  // contract that ultimately persists the trimmed value).
  expect(providerCredentialUpdates.at(-1)).toMatchObject({
    method: "PUT",
    provider: "claude",
    body: { apiKey: "sk-ant-abc123" },
  });

  // Once the credential is stored, the row flips to "Replace".
  await expect(claudeRow.getByRole("button", { name: "Replace" })).toBeVisible();

  // Pick Claude as the chat model preference. Both provider and model are
  // closed-set Selects sourced from the backend catalog.
  const chatRow = page.getByTestId('llm-model-row-chat');
  await page.locator('#provider-chat').click();
  await page.getByRole("option", { name: /Anthropic Claude/ }).click();
  await page.locator('#model-chat').click();
  await page.getByRole("option", { name: "claude-sonnet-4-6" }).click();
  await chatRow.getByRole("button", { name: "Save" }).click();

  await expect.poll(() => llmModelUpdates.length).toBeGreaterThanOrEqual(1);
  expect(llmModelUpdates.at(-1)).toMatchObject({
    chat: { provider: "claude", model: "claude-sonnet-4-6" },
  });

  // After save, the chat row shows the workspace-override hint and the model
  // input still holds the saved value on a fresh load — the GET /settings/llm-models
  // mock now returns Claude.
  await expect(page.getByText("Workspace override").first()).toBeVisible();

  await page.goto(`/w/${workspaceKey}/settings?tab=providers`);
  await expect(page.getByRole("heading", { name: "Models" })).toBeVisible();
  // The Select shows the saved model id in its trigger after the catalog loads.
  await expect(page.locator('#model-chat')).toContainText("claude-sonnet-4-6");
});
