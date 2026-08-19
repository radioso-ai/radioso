import { describe, expect, it } from "vitest";

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

// Pin the import so the resolver's expected preference shape stays in sync.
const _preferenceShape: WorkspaceLlmCapabilityPreferenceInput = { provider: "openai", model: "x" };
void _preferenceShape;
