import { expect, test } from "@playwright/test";

import {
  baseIngestionSettings,
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
  // closed-set Selects sourced from the backend catalog; selection autosaves.
  await page.locator('#provider-chat').click();
  await page.getByRole("option", { name: /Anthropic Claude/ }).click();
  await page.locator('#model-chat').click();
  await page.getByRole("option", { name: "claude-sonnet-4-6" }).click();

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

test("provider settings keep exactly the existing four embedding choices and no advanced vector controls", async ({ page }) => {
  const ingestionSettingsUpdates: unknown[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    platformSettings: basePlatformSettings(),
    ingestionSettings: baseIngestionSettings(),
    ingestionSettingsUpdates,
  });

  await page.goto(`/w/${workspaceKey}/settings?tab=providers`);

  const embeddingsRow = page.getByTestId("llm-model-row-embeddings");
  await expect(embeddingsRow).toBeVisible();
  await expect(embeddingsRow.getByText("Workspace embedding model")).toBeVisible();
  await expect(embeddingsRow.getByText(
    /custom embedding model|embedding dimension|embedding profile|vector backend/i,
  )).toHaveCount(0);

  await page.locator("#provider-embeddings").click();
  await page.getByRole("option", { name: "Google Gemini" }).click();
  const geminiConfirmation = page.getByRole("alertdialog", { name: "Change embedding model?" });
  await expect(geminiConfirmation).toContainText("Google Gemini Embedding");
  await geminiConfirmation.getByRole("button", { name: "Cancel" }).click();

  await page.locator("#model-embeddings").click();
  await expect(page.getByRole("option")).toHaveText([
    "OpenAI text-embedding-3-small",
    "OpenAI text-embedding-3-large",
    "OpenAI text-embedding-ada-002",
  ]);
  await page.getByRole("option", { name: "OpenAI text-embedding-3-large" }).click();

  await expect(page.getByRole("alertdialog", { name: "Change embedding model?" })).toBeVisible();
  await page.getByRole("button", { name: "Change model and re-index" }).click();

  await expect.poll(() => ingestionSettingsUpdates.length).toBeGreaterThanOrEqual(1);
  expect(ingestionSettingsUpdates.at(-1)).toMatchObject({
    embeddingModel: "text-embedding-3-large",
  });
  await expect(embeddingsRow.getByText("Re-indexing", { exact: true })).toBeVisible();
  await expect(embeddingsRow.getByTestId("embedding-model-transition-summary")).toHaveText(
    "Active: OpenAI text-embedding-3-small. Pending: OpenAI text-embedding-3-large.",
  );
  await expect(embeddingsRow.getByTestId("embedding-model-reindex-activity")).toHaveText(
    "Re-indexing queue active. This can take a while; you can keep working while search uses the active model.",
  );

  await embeddingsRow.getByRole("button", { name: "Cancel" }).click();
  await expect(embeddingsRow.getByText("Workspace embedding model")).toBeVisible();
  await expect(embeddingsRow.getByTestId("embedding-model-transition-summary")).toHaveCount(0);
  await expect(page.locator("#model-embeddings")).toContainText("OpenAI text-embedding-3-small");
});

test("provider settings retain the active embedding model when transition startup fails", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    platformSettings: basePlatformSettings(),
    ingestionSettings: baseIngestionSettings(),
    ingestionSettingsUpdateError: "The replacement model could not be validated. The active model is unchanged.",
  });

  await page.goto(`/w/${workspaceKey}/settings?tab=providers`);

  const embeddingsRow = page.getByTestId("llm-model-row-embeddings");
  await page.locator("#model-embeddings").click();
  await page.getByRole("option", { name: "OpenAI text-embedding-3-large" }).click();
  await page.getByRole("button", { name: "Change model and re-index" }).click();

  const dialog = page.getByRole("alertdialog", { name: "Change embedding model?" });
  await expect(dialog).toContainText(
    "The replacement model could not be validated. The active model is unchanged.",
  );
  await dialog.getByRole("button", { name: "Cancel" }).click();

  await expect(embeddingsRow.getByText("Workspace embedding model")).toBeVisible();
  await expect(embeddingsRow.getByText("Re-indexing", { exact: true })).toHaveCount(0);
  await expect(page.locator("#model-embeddings")).toContainText("OpenAI text-embedding-3-small");
});
