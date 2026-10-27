import { describe, expect, it, vi } from "vitest";

import { buildLlmCapabilityResolver, buildLlmRegistry } from "../../src/app/server/builders/integrations.js";
import { getEnv } from "../../src/app/config/env.js";
import { resolveLlmConfig } from "../../src/shared/infra/llm/providerConfig.js";
import type { ManagedModelPolicy } from "../../src/shared/domain/managedModelPolicy.js";
import { WorkspaceLlmCapabilitySettingsService } from "../../src/modules/settings/composition.js";
import { WorkspaceProviderCredentialsService } from "../../src/modules/security/credentials/services/workspaceProviderCredentialsService.js";

const baseEnv = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://test:test@localhost:5432/test",
  OPENAI_API_KEY: "env-openai-key",
  ANTHROPIC_API_KEY: "env-claude-key",
  SESSION_COOKIE_SECRET: "0123456789abcdef0123456789abcdef",
} as const;

const noopManagedModelPolicy: ManagedModelPolicy = {
  async resolveManagedModel() {
    return null;
  },
};

describe("buildLlmCapabilityResolver OpenAI data residency wiring", () => {
  it("reaches a native openai call even when the env default for that capability is a different provider", async () => {
    // The env's own chat default is claude; a workspace preference moves chat onto openai using
    // the platform (env) key. The platform's OPENAI_DATA_RESIDENCY still has to apply here, so
    // the fix cannot only key off the capability's own env default provider.
    const env = getEnv({ ...baseEnv, LLM_CHAT_PROVIDER: "claude", OPENAI_DATA_RESIDENCY: "eu" });
    const defaults = resolveLlmConfig(env);
    expect(defaults.chat.provider).toBe("claude");

    const settings = {
      getPreference: vi.fn(async () => ({
        workspaceId: "ws-1",
        capability: "chat" as const,
        provider: "openai" as const,
        model: "gpt-5.2",
        updatedAt: new Date(),
      })),
    } as unknown as WorkspaceLlmCapabilitySettingsService;
    const credentials = {
      getApiKey: vi.fn(async () => undefined),
      hasCredentials: vi.fn(async () => false),
    } as unknown as WorkspaceProviderCredentialsService;

    const resolver = buildLlmCapabilityResolver({
      env,
      defaults,
      settings,
      credentials,
      managedModelPolicy: noopManagedModelPolicy,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    });

    const config = await resolver.resolve("chat", { workspaceId: "ws-1" });

    expect(config).toMatchObject({
      provider: "openai",
      apiKey: "env-openai-key",
      baseUrl: "https://eu.api.openai.com/v1",
    });
  });
});

describe("buildLlmRegistry startup residency log", () => {
  it("logs a content-free, OpenAI-only provider-residency line once per startup", () => {
    // RESEND_CHANNEL_REGION is set here specifically to prove the LLM builder doesn't read
    // email-channel config at all: the email channel's own composition logs its own region.
    const env = getEnv({ ...baseEnv, OPENAI_DATA_RESIDENCY: "eu", RESEND_CHANNEL_REGION: "eu-west-1" });
    const info = vi.fn();
    const logger = { info, debug: vi.fn(), warn: vi.fn(), error: vi.fn() };

    buildLlmRegistry(env, logger as never);

    const residencyCalls = info.mock.calls.filter(([, message]) => message === "Resolved provider residency");
    expect(residencyCalls).toHaveLength(1);
    const [payload] = residencyCalls[0] as [Record<string, unknown>, string];
    expect(payload).toEqual({ openai: "eu" });

    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("env-openai-key");
    expect(serialized).not.toContain("eu-west-1");
    expect(serialized).not.toMatch(/https?:\/\//);
  });

  it("skips the residency log entirely when no platform OpenAI key is configured", () => {
    const env = getEnv({
      NODE_ENV: "test",
      DATABASE_URL: "postgres://test:test@localhost:5432/test",
      ANTHROPIC_API_KEY: "env-claude-key",
      LLM_PROVIDER: "claude",
      SESSION_COOKIE_SECRET: "0123456789abcdef0123456789abcdef",
      OPENAI_DATA_RESIDENCY: "eu",
    });
    const info = vi.fn();
    const logger = { info, debug: vi.fn(), warn: vi.fn(), error: vi.fn() };

    buildLlmRegistry(env, logger as never);

    const residencyCalls = info.mock.calls.filter(([, message]) => message === "Resolved provider residency");
    expect(residencyCalls).toHaveLength(0);
  });

  it("logs azure plus the Azure resource host (never the key or the full endpoint URL) when AZURE_OPENAI_ENDPOINT is set", () => {
    const env = getEnv({
      ...baseEnv,
      AZURE_OPENAI_ENDPOINT: "https://radioso-eu-1.openai.azure.com",
    });
    const info = vi.fn();
    const logger = { info, debug: vi.fn(), warn: vi.fn(), error: vi.fn() };

    buildLlmRegistry(env, logger as never);

    const residencyCalls = info.mock.calls.filter(([, message]) => message === "Resolved provider residency");
    expect(residencyCalls).toHaveLength(1);
    const [payload] = residencyCalls[0] as [Record<string, unknown>, string];
    expect(payload).toEqual({ openai: "azure", azureHost: "radioso-eu-1.openai.azure.com" });

    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("env-openai-key");
    expect(serialized).not.toMatch(/\/openai\/v1/);
  });
});
