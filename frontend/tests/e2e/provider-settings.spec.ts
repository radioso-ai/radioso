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

test("workspace operator picks a residency before saving an OpenAI key, then changes it alone", async ({ page }) => {
  const providerCredentialUpdates: Array<{ method: "PUT" | "DELETE"; provider: string; body?: unknown }> = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings(), providerCredentialUpdates });

  await page.goto(`/w/${workspaceKey}/settings?tab=providers`);
  const openAiRow = page.locator("#provider-credentials li").filter({ has: page.getByText("OpenAI", { exact: true }) });

  // No stored key yet: the residency choice lives in the key editor, not as a standalone control.
  await expect(page.locator("#openai-residency")).toHaveCount(0);

  // Picking EU while entering the key carries it into the save.
  await openAiRow.getByRole("button", { name: "Set key" }).click();
  await expect(openAiRow.locator("#openai-residency")).toContainText("Global");
  await openAiRow.locator("#openai-residency").click();
  await page.getByRole("option", { name: "EU" }).click();
  await openAiRow.getByPlaceholder("OpenAI API key").fill("  sk-test-openai-123  ");
  await openAiRow.getByRole("button", { name: "Save" }).click();

  await expect.poll(() => providerCredentialUpdates.length).toBeGreaterThanOrEqual(1);
  expect(providerCredentialUpdates.at(-1)).toMatchObject({
    method: "PUT",
    provider: "openai",
    body: { apiKey: "sk-test-openai-123", residency: "eu" },
  });
  await expect(openAiRow.getByRole("button", { name: "Replace" })).toBeVisible();

  // With the key already stored, the standalone residency control changes it alone, sending no apiKey.
  const storedResidency = openAiRow.locator("#openai-residency");
  await expect(storedResidency).toContainText("EU");
  await storedResidency.click();
  await page.getByRole("option", { name: "US" }).click();

  await expect.poll(() => providerCredentialUpdates.length).toBeGreaterThanOrEqual(2);
  expect(providerCredentialUpdates.at(-1)).toEqual({
    method: "PUT",
    provider: "openai",
    body: { residency: "us" },
  });

  await page.reload();
  await expect(page.locator("#openai-residency")).toContainText("US");
});

test("workspace operator stores the ElevenLabs key voice sessions start with, finds it configured after a reload, and removes it", async ({ page }) => {
  const providerCredentialUpdates: Array<{ method: "PUT" | "DELETE"; provider: string; body?: unknown }> = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings(), providerCredentialUpdates });

  await page.goto(`/w/${workspaceKey}/settings?tab=providers`);
  const card = page.locator("#voice-vendor-credentials");
  await expect(card.getByRole("heading", { name: "Voice runtime keys" })).toBeVisible();
  const elevenLabsRow = card.locator("li", { hasText: "ElevenLabs" });
  // A voice runtime key has no deployment fallback to inherit.
  await expect(elevenLabsRow.getByText("Not configured", { exact: true })).toBeVisible();

  await elevenLabsRow.getByRole("button", { name: "Set key" }).click();
  await elevenLabsRow.getByPlaceholder("ElevenLabs API key").fill("  xi-test-key-0123456789  ");
  await elevenLabsRow.getByRole("button", { name: "Save" }).click();
  await expect(elevenLabsRow.getByText("Workspace key", { exact: true })).toBeVisible();
  expect(providerCredentialUpdates).toEqual([{ method: "PUT", provider: "elevenlabs", body: { apiKey: "xi-test-key-0123456789" } }]);

  await page.reload();
  const reloadedRow = page.locator("#voice-vendor-credentials").locator("li", { hasText: "ElevenLabs" });
  await expect(reloadedRow.getByText("Workspace key", { exact: true })).toBeVisible();
  // The model provider list is unchanged: the voice key is not a model provider.
  await expect(page.locator("#provider-credentials").getByText("ElevenLabs")).toHaveCount(0);

  await reloadedRow.getByRole("button", { name: "Remove" }).click();
  await expect(reloadedRow.getByText("Not configured", { exact: true })).toBeVisible();
  expect(providerCredentialUpdates.at(-1)).toEqual({ method: "DELETE", provider: "elevenlabs" });
});

test("a managed plan shows the plan's model read-only and says how to choose", async ({ page }) => {
  const llmModelUpdates: Array<unknown> = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    platformSettings: basePlatformSettings(),
    llmModelUpdates,
    llmManagedModels: {
      chat: { provider: "claude", model: "claude-sonnet-5" },
      rewrite: { provider: "claude", model: "claude-haiku-4-5" },
    },
  });

  await page.goto(`/w/${workspaceKey}/settings?tab=providers`);
  await expect(page.getByRole("heading", { name: "Models" })).toBeVisible();

  // Chat is locked: both pickers are disabled and show the plan's choice, with
  // the one line that says why and what to do about it.
  const chatRow = page.getByTestId("llm-model-row-chat");
  await expect(chatRow.getByText("Managed plan", { exact: true })).toBeVisible();
  await expect(chatRow.getByTestId("llm-model-managed-chat")).toContainText("claude-sonnet-5");
  await expect(page.locator("#provider-chat")).toBeDisabled();
  await expect(page.locator("#provider-chat")).toContainText("Anthropic Claude");
  await expect(page.locator("#model-chat")).toBeDisabled();
  await expect(page.locator("#model-chat")).toContainText("claude-sonnet-5");
  await expect(chatRow.getByRole("button", { name: "Reset" })).toHaveCount(0);

  // Rewrite is locked to the plan's default model.
  await expect(page.locator("#model-rewrite")).toBeDisabled();
  await expect(page.locator("#model-rewrite")).toContainText("claude-haiku-4-5");

  // Rerank is not managed, so it still opens and saves as usual.
  const rerankRow = page.getByTestId("llm-model-row-rerank");
  await expect(rerankRow.getByText("Default", { exact: true })).toBeVisible();
  await expect(page.locator("#provider-rerank")).toBeEnabled();
  await page.locator("#provider-rerank").click();
  await page.getByRole("option", { name: /^OpenAI \(/ }).click();
  await page.locator("#model-rerank").click();
  await page.getByRole("option", { name: "gpt-5-mini" }).click();
  await expect.poll(() => llmModelUpdates.length).toBeGreaterThanOrEqual(1);
  expect(llmModelUpdates.at(-1)).toMatchObject({ rerank: { provider: "openai", model: "gpt-5-mini" } });
});

test("the model picker offers only models the deployment's shared key runs and flags a saved one it no longer runs", async ({ page }) => {
  const llmModelUpdates: Array<unknown> = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    platformSettings: basePlatformSettings(),
    llmModelUpdates,
    llmModels: {
      chat: { provider: "openai", model: "gpt-5.2" },
      rewrite: { provider: "claude", model: "claude-retired-1" },
    },
    runnableModelsByProvider: { openai: ["gpt-5-mini"] },
  });

  await page.goto(`/w/${workspaceKey}/settings?tab=providers`);
  await expect(page.getByRole("heading", { name: "Models" })).toBeVisible();

  // A saved model the catalog no longer lists still shows, without claiming what answers instead.
  const rewriteRow = page.getByTestId("llm-model-row-rewrite");
  await expect(page.locator("#model-rewrite")).toContainText("claude-retired-1");
  await expect(rewriteRow.getByText(/another model answers in its place/)).toHaveCount(0);

  // The saved pick still shows, with the line that says what runs instead and how to fix it.
  const chatRow = page.getByTestId("llm-model-row-chat");
  await expect(page.locator("#model-chat")).toContainText("gpt-5.2");
  await expect(chatRow.getByText(/another model answers in its place/)).toBeVisible();

  await page.locator("#model-chat").click();
  await expect(page.getByRole("option", { name: "gpt-5.2 (unavailable)" })).toBeDisabled();
  await page.getByRole("option", { name: "gpt-5-mini" }).click();

  await expect.poll(() => llmModelUpdates.length).toBeGreaterThanOrEqual(1);
  expect(llmModelUpdates.at(-1)).toMatchObject({ chat: { provider: "openai", model: "gpt-5-mini" } });
  await expect(chatRow.getByText(/another model answers in its place/)).toHaveCount(0);
});

test("adding the workspace's own OpenAI key makes every OpenAI model pickable without a reload", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    platformSettings: basePlatformSettings(),
    llmModels: { chat: { provider: "openai", model: "gpt-5.2" } },
    runnableModelsByProvider: { openai: ["gpt-5-mini"] },
  });

  await page.goto(`/w/${workspaceKey}/settings?tab=providers`);
  const chatRow = page.getByTestId("llm-model-row-chat");
  await expect(chatRow.getByText(/another model answers in its place/)).toBeVisible();

  const openAiRow = page.locator("#provider-credentials li").filter({ has: page.getByText("OpenAI", { exact: true }) });
  await openAiRow.getByRole("button", { name: "Set key" }).click();
  await openAiRow.getByPlaceholder("OpenAI API key").fill("sk-test-openai-123");
  await openAiRow.getByRole("button", { name: "Save" }).click();
  await expect(openAiRow.getByRole("button", { name: "Replace" })).toBeVisible();

  await expect(chatRow.getByText(/another model answers in its place/)).toHaveCount(0);
  await page.locator("#model-chat").click();
  await expect(page.getByRole("option", { name: "gpt-5.2", exact: true })).toBeEnabled();
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

test("provider settings show how far indexing has got and why it is stuck", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    platformSettings: basePlatformSettings(),
    ingestionSettings: baseIngestionSettings(),
    embeddingCoverage: {
      eligibleChunks: 19318,
      coveredChunks: 14989,
      missingChunks: 4329,
      hasEmbeddingProfile: true,
      queuedJobs: 0,
      failedJobs: 3,
    },
  });

  await page.goto(`/w/${workspaceKey}/settings?tab=providers`);

  // Without this line the only way to see indexing progress was to query the database.
  const embeddingsRow = page.getByTestId("llm-model-row-embeddings");
  await expect(embeddingsRow.getByTestId("embedding-coverage-summary")).toContainText(
    "14,989 of 19,318 chunks indexed",
  );
  // Failed jobs hold their job key, so they never retry — the count is the difference
  // between waiting and intervening.
  await expect(embeddingsRow.getByTestId("embedding-coverage-summary")).toContainText(
    "3 job(s) failed and will not retry on their own.",
  );
});

test("provider settings stay quiet about coverage for a workspace with nothing indexed", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    platformSettings: basePlatformSettings(),
    ingestionSettings: baseIngestionSettings(),
  });

  await page.goto(`/w/${workspaceKey}/settings?tab=providers`);

  const embeddingsRow = page.getByTestId("llm-model-row-embeddings");
  await expect(embeddingsRow.getByText("Workspace embedding model")).toBeVisible();
  await expect(embeddingsRow.getByTestId("embedding-coverage-summary")).toHaveCount(0);
});
