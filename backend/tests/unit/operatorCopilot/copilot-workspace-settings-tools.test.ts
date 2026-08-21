import { describe, expect, it, vi } from "vitest";

import { createWorkspaceSettingsCopilotTools } from "../../../src/modules/operatorCopilot/tools/settings.js";

const context = {
  workspaceId: "workspace-1",
  accountId: "account-1",
  operatorUserId: "operator-1",
  pageContext: { view: "other" as const, agentId: null, conversationId: null, selection: null, entities: [] },
};

const workspaceSettingsPort = () => ({
  getRetrievalDefaults: vi.fn(async () => ({
    queryRewriteEnabled: true,
    temporalStructuredLookupEnabled: true,
    temporalBoostUpcomingEnabled: false,
    temporalDeterministicSortEnabled: true,
    semanticRewriteInstructions: "Rewrite for support terminology.",
    lexicalRewriteInstructions: "Preserve product names.",
    suggestedQuestionsEnabled: true,
    suggestedQuestionsCount: 3,
    rerankEnabled: true,
    vectorTopK: 20,
    similarityThreshold: 0.42,
    rerankTopK: 8,
    retrievalStrategy: "reasoning",
    customInstruction: "Prefer product documentation.",
    metadataRules: [{
      id: "metadata-rule-1",
      field: "region",
      valueType: "string",
      operator: "equals",
      value: "EMEA",
      effect: "filter",
      enabled: true,
      triggerMode: "always_on",
      triggerInstruction: "Only when the customer states a region.",
    }],
    connectionString: "postgres://should-not-leak",
  })),
  getIngestionSettings: vi.fn(async () => ({
    chunkingStrategy: "fixed_window",
    fixedWindowChunkSize: 700,
    fixedWindowChunkOverlap: 100,
    structuredMinChunkSize: 250,
    structuredMaxChunkSize: 1_500,
    embeddingModel: "text-embedding-3-small",
    pendingEmbeddingModel: "text-embedding-3-large",
    documentEnrichmentEnabled: true,
    apiKey: "sk-ingestion-secret",
  })),
  listLlmModels: vi.fn(async () => [
    { capability: "chat" as const, provider: "openai", model: "gpt-5-mini", token: "llm-token" },
    { capability: "rerank" as const, provider: "claude", model: "claude-sonnet-4-5", token: "llm-token" },
  ]),
  getProviderCredentialHealth: vi.fn(async () => ({
    encryptionConfigured: true,
    credentials: [{ provider: "openai", updatedAt: new Date("2026-08-02T09:00:00.000Z"), apiKey: "sk-credential-secret" }],
    envProviderAvailability: { openai: true, "openai-compatible": false, gemini: false, claude: true },
    value: "credential-value-secret",
  })),
  getGeneralSettings: vi.fn(async () => ({
    assistant: {
      assistantName: "Support",
      greetingInstruction: "Greet warmly.",
      assistantDefaultLocale: "en",
      proactiveGreetingEnabled: true,
      assistantBootstrapActive: false,
      suggestedQuestionsEnabled: true,
      customInstruction: "Use the policy documents.",
      assistantLogoUrl: "https://app.example.test/logo/anonymous-chat-token",
      workspaceApiToken: "workspace-api-token",
    },
    channels: {
      anonymousChatEnabled: true,
      anonymousChatLastUsedAt: "2026-08-03T10:00:00.000Z",
      anonymousChatUrl: "https://app.example.test/anonymous-chat-token",
      anonymousChatToken: "anonymous-chat-token",
      websiteEmbedEnabled: true,
      websiteEmbedLastUsedAt: "2026-08-04T10:00:00.000Z",
      websiteEmbedToken: "website-embed-token",
      websiteEmbedScriptUrl: "https://app.example.test/embed.js",
      websiteEmbedSnippet: "<script data-token=website-embed-token>",
      websiteEmbedAllowedOrigins: ["https://example.test"],
      websiteEmbedLauncherLabel: "Ask Support",
      websiteEmbedLauncherPosition: "bottom-right",
      websiteEmbedTheme: { mode: "light" },
      websiteEmbedCopy: { welcome: "How can we help?" },
      websiteEmbedExpertOverrides: { accent: "blue" },
      webhookSecret: "webhook-secret",
    },
  })),
});

describe("workspace settings copilot reader", () => {
  it("declares one read-shaped settings reader", () => {
    const descriptors = createWorkspaceSettingsCopilotTools({ workspaceSettings: workspaceSettingsPort() });

    expect(descriptors.map(({ name, requiredPermissions, contributingModule, uiLabel, shape }) => ({ name, requiredPermissions, contributingModule, uiLabel, shape }))).toEqual([
      {
        name: "workspace_settings",
        requiredPermissions: ["workspace.settings.read"],
        contributingModule: "settings",
        uiLabel: "Reading workspace settings",
        shape: "read",
      },
    ]);
  });

  it("reads retrieval, ingestion, LLM, credential-health, and general workspace configuration", async () => {
    const workspaceSettings = workspaceSettingsPort();
    const [descriptor] = createWorkspaceSettingsCopilotTools({ workspaceSettings });

    const result = await descriptor.createTool(context).invoke({}, {} as never);

    expect(workspaceSettings.getRetrievalDefaults).toHaveBeenCalledWith("workspace-1");
    expect(workspaceSettings.getIngestionSettings).toHaveBeenCalledWith("workspace-1");
    expect(workspaceSettings.listLlmModels).toHaveBeenCalledWith("workspace-1");
    expect(workspaceSettings.getProviderCredentialHealth).toHaveBeenCalledWith("workspace-1");
    expect(workspaceSettings.getGeneralSettings).toHaveBeenCalledWith("workspace-1");
    expect(result).toMatchObject({
      retrieval: {
        vectorTopK: 20,
        similarityThreshold: 0.42,
        rerankTopK: 8,
        metadataRules: [{ field: "region", operator: "equals", effect: "filter" }],
      },
      ingestion: {
        embeddingModel: "text-embedding-3-small",
        pendingEmbeddingModel: "text-embedding-3-large",
      },
      llmModels: {
        chat: { provider: "openai", model: "gpt-5-mini" },
        rewrite: null,
        rerank: { provider: "claude", model: "claude-sonnet-4-5" },
      },
      credentials: {
        encryptionConfigured: true,
        configuredProviders: [{ provider: "openai", updatedAt: "2026-08-02T09:00:00.000Z" }],
        envProviderAvailability: { openai: true, "openai-compatible": false, gemini: false, claude: true },
      },
      general: {
        assistant: { assistantName: "Support", assistantDefaultLocale: "en" },
        channels: { anonymousChatEnabled: true, websiteEmbedEnabled: true, websiteEmbedScriptUrl: "https://app.example.test/embed.js" },
      },
    });
  });

  it("never emits secrets, tokens, credential values, or connection strings", async () => {
    const [descriptor] = createWorkspaceSettingsCopilotTools({ workspaceSettings: workspaceSettingsPort() });

    const serialized = JSON.stringify(await descriptor.createTool(context).invoke({}, {} as never));

    for (const secret of [
      "postgres://should-not-leak",
      "sk-ingestion-secret",
      "llm-token",
      "sk-credential-secret",
      "credential-value-secret",
      "anonymous-chat-token",
      "website-embed-token",
      "workspace-api-token",
      "webhook-secret",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    for (const field of ["apiKey", "token", "connectionString", "anonymousChatToken", "websiteEmbedToken", "workspaceApiToken", "webhookSecret"]) {
      expect(serialized).not.toContain(field);
    }
  });
});
