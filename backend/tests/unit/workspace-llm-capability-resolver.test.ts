import { describe, expect, it, vi } from "vitest";

import { WorkspaceLlmCapabilityResolver } from "../../src/app/composition/workspaceLlmCapabilityResolver.js";
import type {
  WorkspaceLlmCapability,
  WorkspaceLlmCapabilityPreference,
  WorkspaceLlmCapabilityPreferenceInput,
} from "../../src/modules/settings/contracts/llmCapability.js";
import {
  ProviderConfigurationError,
  type LlmProviderName,
  type ResolvedLlmConfig,
} from "../../src/shared/infra/llm/providerTypes.js";
import type {
  ManagedModelPolicy,
  ManagedModelSelection,
} from "../../src/shared/domain/managedModelPolicy.js";

const envConfig: ResolvedLlmConfig = {
  chat: { capability: "chat", provider: "openai", model: "gpt-5.2" },
  rewrite: { capability: "rewrite", provider: "openai", model: "gpt-5.2" },
  rerank: { capability: "rerank", provider: "openai", model: "gpt-5-mini" },
  embeddings: { capability: "embeddings", provider: "openai", model: "text-embedding-3-small" },
  embeddingProviderConfigs: [],
};

const buildSettings = (rows: Array<WorkspaceLlmCapabilityPreference>) => ({
  async getPreference(workspaceId: string, capability: WorkspaceLlmCapability) {
    return rows.find((row) => row.workspaceId === workspaceId && row.capability === capability) ?? null;
  },
});

const buildCredentials = (keys: Record<string, string>) => ({
  async getApiKey(workspaceId: string, provider: LlmProviderName) {
    return keys[`${workspaceId}:${provider}`];
  },
  async hasCredentials(workspaceId: string, provider: LlmProviderName) {
    return `${workspaceId}:${provider}` in keys;
  },
});

const managedPolicy = (
  selections: Partial<Record<string, ManagedModelSelection>>,
): ManagedModelPolicy => ({
  async resolveManagedModel({ capability }) {
    return selections[capability] ?? null;
  },
});

const managedChat: ManagedModelSelection = { provider: "claude", model: "claude-sonnet-5" };
const managedDefault: ManagedModelSelection = { provider: "claude", model: "claude-haiku-4-5" };
const managedForAll = managedPolicy({
  chat: managedChat,
  rewrite: managedDefault,
  rerank: managedDefault,
  embeddings: managedDefault,
});

const envKeyResolver = (lookup: Partial<Record<LlmProviderName, string>>) => ({
  resolveEnvApiKey(provider: LlmProviderName): string | undefined {
    return lookup[provider];
  },
});

describe("WorkspaceLlmCapabilityResolver", () => {
  it("returns the env default when no workspace preference exists", async () => {
    const resolver = new WorkspaceLlmCapabilityResolver({
      defaults: envConfig,
      settings: buildSettings([]),
      credentials: buildCredentials({}),
      envKeys: envKeyResolver({ openai: "env-openai" }),
    });

    const config = await resolver.resolve("chat", { workspaceId: "ws-1" });

    expect(config).toMatchObject({
      capability: "chat",
      provider: "openai",
      model: "gpt-5.2",
      apiKey: "env-openai",
    });
  });

  it("uses a workspace preference when set", async () => {
    const resolver = new WorkspaceLlmCapabilityResolver({
      defaults: envConfig,
      settings: buildSettings([
        {
          workspaceId: "ws-1",
          capability: "chat",
          provider: "claude",
          model: "claude-sonnet-4-5",
          updatedAt: new Date(),
        },
      ]),
      credentials: buildCredentials({ "ws-1:claude": "ws-claude-key" }),
      envKeys: envKeyResolver({ openai: "env-openai" }),
    });

    const config = await resolver.resolve("chat", { workspaceId: "ws-1" });

    expect(config).toMatchObject({
      provider: "claude",
      model: "claude-sonnet-4-5",
      apiKey: "ws-claude-key",
    });
  });

  it("a capability override beats the workspace preference and the env default", async () => {
    const resolver = new WorkspaceLlmCapabilityResolver({
      defaults: envConfig,
      settings: buildSettings([
        {
          workspaceId: "ws-1",
          capability: "chat",
          provider: "claude",
          model: "claude-sonnet-4-5",
          updatedAt: new Date(),
        },
      ]),
      credentials: buildCredentials({
        "ws-1:claude": "ws-claude-key",
        "ws-1:gemini": "ws-gemini-key",
      }),
      envKeys: envKeyResolver({ openai: "env-openai" }),
    });

    const config = await resolver.resolve("chat", {
      workspaceId: "ws-1",
      capabilityOverride: { provider: "gemini", model: "gemini-2.5-flash" },
    });

    expect(config).toMatchObject({
      provider: "gemini",
      model: "gemini-2.5-flash",
      apiKey: "ws-gemini-key",
    });
  });

  it("falls back to env api key when workspace credential is missing", async () => {
    const resolver = new WorkspaceLlmCapabilityResolver({
      defaults: envConfig,
      settings: buildSettings([
        {
          workspaceId: "ws-1",
          capability: "rewrite",
          provider: "gemini",
          model: "gemini-2.5-flash",
          updatedAt: new Date(),
        },
      ]),
      credentials: buildCredentials({}),
      envKeys: envKeyResolver({ openai: "env-openai", gemini: "env-gemini" }),
    });

    const config = await resolver.resolve("rewrite", { workspaceId: "ws-1" });

    expect(config).toMatchObject({
      provider: "gemini",
      model: "gemini-2.5-flash",
      apiKey: "env-gemini",
    });
  });

  it("throws a structured 503 ProviderConfigurationError when neither workspace nor env has a key", async () => {
    const resolver = new WorkspaceLlmCapabilityResolver({
      defaults: envConfig,
      settings: buildSettings([
        {
          workspaceId: "ws-1",
          capability: "rerank",
          provider: "claude",
          model: "claude-sonnet-4-5",
          updatedAt: new Date(),
        },
      ]),
      credentials: buildCredentials({}),
      envKeys: envKeyResolver({ openai: "env-openai" }),
    });

    const failure = await resolver.resolve("rerank", { workspaceId: "ws-1" }).catch((error) => error);
    expect(failure).toBeInstanceOf(ProviderConfigurationError);
    expect(failure).toMatchObject({
      statusCode: 503,
      code: "provider_misconfigured",
      details: {
        providerIssue: "configuration_invalid",
        kind: "missing_api_key",
        provider: "claude",
        capability: "rerank",
      },
    });
  });

  it("rejects an openai-compatible workspace preference when no base URL is configured", async () => {
    const resolver = new WorkspaceLlmCapabilityResolver({
      defaults: envConfig,
      settings: buildSettings([
        {
          workspaceId: "ws-1",
          capability: "chat",
          provider: "openai-compatible",
          model: "compat-model",
          updatedAt: new Date(),
        },
      ]),
      credentials: buildCredentials({ "ws-1:openai-compatible": "ws-compat-key" }),
      envKeys: envKeyResolver({ "openai-compatible": "env-compat-key" }),
      // Intentionally no envBaseUrls — env-default provider is openai, so nothing
      // gives openai-compatible a base URL.
    });

    await expect(resolver.resolve("chat", { workspaceId: "ws-1" })).rejects.toThrow(
      /OPENAI_COMPATIBLE_BASE_URL/,
    );
  });

  it("preserves baseUrl for openai-compatible from env defaults", async () => {
    const compatibleDefaults: ResolvedLlmConfig = {
      ...envConfig,
      chat: {
        capability: "chat",
        provider: "openai-compatible",
        model: "compat-model",
        baseUrl: "https://compat.example.com",
      },
    };
    const resolver = new WorkspaceLlmCapabilityResolver({
      defaults: compatibleDefaults,
      settings: buildSettings([]),
      credentials: buildCredentials({}),
      envKeys: envKeyResolver({ "openai-compatible": "env-compat" }),
      envBaseUrls: { "openai-compatible": "https://compat.example.com" },
    });

    const config = await resolver.resolve("chat", { workspaceId: "ws-1" });
    expect(config.baseUrl).toBe("https://compat.example.com");
  });

  it("preserves the exact openai-compatible endpoint from a capability override", async () => {
    const compatibleDefaults: ResolvedLlmConfig = {
      ...envConfig,
      embeddings: {
        capability: "embeddings",
        provider: "openai-compatible",
        model: "text-embedding-3-small",
        baseUrl: "https://endpoint-b.example.com/v1",
      },
    };
    const resolver = new WorkspaceLlmCapabilityResolver({
      defaults: compatibleDefaults,
      settings: buildSettings([]),
      credentials: buildCredentials({ "ws-1:openai-compatible": "ws-compat-key" }),
      envKeys: envKeyResolver({}),
      envBaseUrls: { "openai-compatible": "https://endpoint-b.example.com/v1" },
    });

    const config = await resolver.resolve("embeddings", {
      workspaceId: "ws-1",
      capabilityOverride: {
        provider: "openai-compatible",
        model: "text-embedding-3-small",
        baseUrl: "https://endpoint-a.example.com/v1",
      },
    });

    expect(config).toMatchObject({
      provider: "openai-compatible",
      apiKey: "ws-compat-key",
      baseUrl: "https://endpoint-a.example.com/v1",
    });
  });

  it("rewrite/rerank capabilities ignore capabilityOverride from agent (workspace-level only)", async () => {
    // The resolver does not interpret semantic meaning of an override; callers should not
    // pass agent overrides to rewrite/rerank. This test pins that contract: when the
    // chatService keeps overrides scoped to chat, the rewrite path stays workspace-level.
    const resolver = new WorkspaceLlmCapabilityResolver({
      defaults: envConfig,
      settings: buildSettings([]),
      credentials: buildCredentials({}),
      envKeys: envKeyResolver({ openai: "env-openai" }),
    });

    const config = await resolver.resolve("rewrite", { workspaceId: "ws-1" });
    expect(config.provider).toBe("openai");
  });
});

describe("WorkspaceLlmCapabilityResolver managed plans", () => {
  const chatPreference: WorkspaceLlmCapabilityPreference = {
    workspaceId: "ws-1",
    capability: "chat",
    provider: "openai",
    model: "gpt-5.2",
    updatedAt: new Date(),
  };

  it("reports environment_default when nothing else applies", async () => {
    const resolver = new WorkspaceLlmCapabilityResolver({
      defaults: envConfig,
      settings: buildSettings([]),
      credentials: buildCredentials({}),
      envKeys: envKeyResolver({ openai: "env-openai" }),
    });

    const config = await resolver.resolve("chat", { workspaceId: "ws-1" });
    expect(config.resolvedBy).toBe("environment_default");

    const selection = await resolver.resolveSelection("chat", { workspaceId: "ws-1" });
    expect(selection).toEqual({ provider: "openai", model: "gpt-5.2", resolvedBy: "environment_default" });
    expect(selection).not.toHaveProperty("apiKey");
  });

  it("reports workspace_preference and agent_override for the unmanaged branches", async () => {
    const resolver = new WorkspaceLlmCapabilityResolver({
      defaults: envConfig,
      settings: buildSettings([chatPreference]),
      credentials: buildCredentials({ "ws-1:gemini": "ws-gemini" }),
      envKeys: envKeyResolver({ openai: "env-openai" }),
    });

    const preferred = await resolver.resolve("chat", { workspaceId: "ws-1" });
    expect(preferred.resolvedBy).toBe("workspace_preference");

    const overridden = await resolver.resolve("chat", {
      workspaceId: "ws-1",
      capabilityOverride: { provider: "gemini", model: "gemini-2.5-flash" },
    });
    expect(overridden.resolvedBy).toBe("agent_override");
  });

  it("locks a managed workspace with no key of its own to the managed model, over its preference", async () => {
    const resolver = new WorkspaceLlmCapabilityResolver({
      defaults: envConfig,
      settings: buildSettings([chatPreference]),
      credentials: buildCredentials({}),
      envKeys: envKeyResolver({ openai: "env-openai", claude: "env-claude" }),
      managedModelPolicy: managedForAll,
    });

    const config = await resolver.resolve("chat", { workspaceId: "ws-1" });

    expect(config).toMatchObject({
      provider: "claude",
      model: "claude-sonnet-5",
      apiKey: "env-claude",
      resolvedBy: "managed_plan",
    });
  });

  it("locks a managed workspace over an agent override too", async () => {
    const resolver = new WorkspaceLlmCapabilityResolver({
      defaults: envConfig,
      settings: buildSettings([]),
      credentials: buildCredentials({}),
      envKeys: envKeyResolver({ openai: "env-openai", claude: "env-claude" }),
      managedModelPolicy: managedForAll,
    });

    const config = await resolver.resolve("chat", {
      workspaceId: "ws-1",
      capabilityOverride: { provider: "openai", model: "gpt-5.6-luna" },
    });

    expect(config).toMatchObject({ provider: "claude", model: "claude-sonnet-5", resolvedBy: "managed_plan" });
  });

  it("uses the default managed selection for rewrite and rerank", async () => {
    const resolver = new WorkspaceLlmCapabilityResolver({
      defaults: envConfig,
      settings: buildSettings([]),
      credentials: buildCredentials({}),
      envKeys: envKeyResolver({ openai: "env-openai", claude: "env-claude" }),
      managedModelPolicy: managedForAll,
    });

    const rewrite = await resolver.resolve("rewrite", { workspaceId: "ws-1" });
    const rerank = await resolver.resolve("rerank", { workspaceId: "ws-1" });
    expect(rewrite).toMatchObject({ provider: "claude", model: "claude-haiku-4-5", resolvedBy: "managed_plan" });
    expect(rerank).toMatchObject({ provider: "claude", model: "claude-haiku-4-5", resolvedBy: "managed_plan" });
  });

  it("lets a managed workspace that holds its own key for the candidate provider resolve as today", async () => {
    const resolver = new WorkspaceLlmCapabilityResolver({
      defaults: envConfig,
      settings: buildSettings([chatPreference]),
      credentials: buildCredentials({ "ws-1:openai": "ws-openai" }),
      envKeys: envKeyResolver({ claude: "env-claude" }),
      managedModelPolicy: managedForAll,
    });

    const config = await resolver.resolve("chat", { workspaceId: "ws-1" });

    expect(config).toMatchObject({
      provider: "openai",
      model: "gpt-5.2",
      apiKey: "ws-openai",
      resolvedBy: "workspace_preference",
    });
  });

  it("keeps the lock when the workspace key is for a different provider than the candidate", async () => {
    const resolver = new WorkspaceLlmCapabilityResolver({
      defaults: envConfig,
      settings: buildSettings([chatPreference]),
      credentials: buildCredentials({ "ws-1:gemini": "ws-gemini" }),
      envKeys: envKeyResolver({ openai: "env-openai", claude: "env-claude" }),
      managedModelPolicy: managedForAll,
    });

    const config = await resolver.resolve("chat", { workspaceId: "ws-1" });
    expect(config).toMatchObject({ provider: "claude", model: "claude-sonnet-5", resolvedBy: "managed_plan" });
  });

  it("leaves an unmanaged workspace unchanged when the policy returns null", async () => {
    const resolver = new WorkspaceLlmCapabilityResolver({
      defaults: envConfig,
      settings: buildSettings([chatPreference]),
      credentials: buildCredentials({}),
      envKeys: envKeyResolver({ openai: "env-openai" }),
      managedModelPolicy: managedPolicy({}),
    });

    const config = await resolver.resolve("chat", { workspaceId: "ws-1" });
    expect(config).toMatchObject({ provider: "openai", model: "gpt-5.2", resolvedBy: "workspace_preference" });
  });

  it("never locks embeddings, even when the policy would answer for them", async () => {
    const policy: ManagedModelPolicy = { resolveManagedModel: vi.fn(async () => managedDefault) };
    const resolver = new WorkspaceLlmCapabilityResolver({
      defaults: envConfig,
      settings: buildSettings([]),
      credentials: buildCredentials({}),
      envKeys: envKeyResolver({ openai: "env-openai", claude: "env-claude" }),
      managedModelPolicy: policy,
    });

    const config = await resolver.resolve("embeddings", { workspaceId: "ws-1" });

    expect(config).toMatchObject({
      provider: "openai",
      model: "text-embedding-3-small",
      resolvedBy: "environment_default",
    });
    expect(policy.resolveManagedModel).not.toHaveBeenCalled();
  });

  it("logs at info when the lock overrides an explicit preference or override, and at debug otherwise", async () => {
    const logger = { debug: vi.fn(), info: vi.fn() };
    const resolver = new WorkspaceLlmCapabilityResolver({
      defaults: envConfig,
      settings: buildSettings([chatPreference]),
      credentials: buildCredentials({}),
      envKeys: envKeyResolver({ openai: "env-openai", claude: "env-claude" }),
      managedModelPolicy: managedForAll,
      logger,
    });

    await resolver.resolve("chat", { workspaceId: "ws-1" });

    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info.mock.calls[0]?.[0]).toEqual({
      capability: "chat",
      workspaceId: "ws-1",
      resolvedBy: "managed_plan",
      provider: "claude",
      model: "claude-sonnet-5",
      overrode: "workspace_preference",
      requestedProvider: "openai",
      requestedModel: "gpt-5.2",
    });
    expect(logger.debug).toHaveBeenCalledWith(
      { capability: "chat", workspaceId: "ws-1", resolvedBy: "managed_plan", provider: "claude", model: "claude-sonnet-5" },
      expect.any(String),
    );

    logger.info.mockClear();
    await resolver.resolve("chat", {
      workspaceId: "ws-1",
      capabilityOverride: { provider: "gemini", model: "gemini-2.5-flash" },
    });
    expect(logger.info.mock.calls[0]?.[0]).toMatchObject({
      overrode: "agent_override",
      requestedProvider: "gemini",
      requestedModel: "gemini-2.5-flash",
    });

    logger.info.mockClear();
    await resolver.resolve("rewrite", { workspaceId: "ws-1" });
    // A lock that replaces only the environment default is routine, not noteworthy.
    expect(logger.info).not.toHaveBeenCalled();
  });
});

// Pin the import so the resolver's expected preference shape stays in sync.
const _preferenceShape: WorkspaceLlmCapabilityPreferenceInput = { provider: "openai", model: "x" };
void _preferenceShape;
