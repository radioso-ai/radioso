import { afterEach, describe, expect, it, vi } from "vitest";

// Deliberately does not mock the "openai" package: these tests need the real SDK making a real
// fetch call, so the actual request host can be observed and OPENAI_BASE_URL's env fallback can
// be proven to have no effect.
import { createOpenAIClient, OpenAITextGenerationClient } from "../../src/shared/infra/llm/openaiProvider.js";
import { ProviderConfigurationError } from "../../src/shared/infra/llm/providerTypes.js";
import type { LlmCapabilityConfig } from "../../src/shared/infra/llm/providerTypes.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const configFor = (residency?: "global" | "us" | "eu"): LlmCapabilityConfig => ({
  capability: "chat",
  provider: "openai",
  model: "gpt-test",
  apiKey: "sk-test",
  ...(residency ? { openAIDataResidency: residency } : {}),
});

const requestsTo = () => {
  const requests: string[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    requests.push(input instanceof Request ? input.url : String(input));
    return Response.json({ choices: [{ message: { content: "ok" } }] });
  });
  return requests;
};

describe("native openai host enforcement", () => {
  it("reaches exactly api.openai.com at the default (global) residency", async () => {
    const requests = requestsTo();
    await new OpenAITextGenerationClient(configFor()).complete({ prompt: "hi" });
    expect(requests).toEqual(["https://api.openai.com/v1/chat/completions"]);
  });

  it("reaches exactly eu.api.openai.com at eu residency", async () => {
    const requests = requestsTo();
    await new OpenAITextGenerationClient(configFor("eu")).complete({ prompt: "hi" });
    expect(requests).toEqual(["https://eu.api.openai.com/v1/chat/completions"]);
  });

  it("reaches exactly us.api.openai.com at us residency", async () => {
    const requests = requestsTo();
    await new OpenAITextGenerationClient(configFor("us")).complete({ prompt: "hi" });
    expect(requests).toEqual(["https://us.api.openai.com/v1/chat/completions"]);
  });

  it("ignores OPENAI_BASE_URL entirely: a native client still targets api.openai.com", async () => {
    vi.stubEnv("OPENAI_BASE_URL", "https://attacker.example/v1");
    const requests = requestsTo();

    await new OpenAITextGenerationClient(configFor()).complete({ prompt: "hi" });

    expect(requests).toEqual(["https://api.openai.com/v1/chat/completions"]);
  });

  it("ignores OPENAI_BASE_URL at eu residency too", async () => {
    vi.stubEnv("OPENAI_BASE_URL", "https://attacker.example/v1");
    const requests = requestsTo();

    await new OpenAITextGenerationClient(configFor("eu")).complete({ prompt: "hi" });

    expect(requests).toEqual(["https://eu.api.openai.com/v1/chat/completions"]);
  });

  it("throws rather than reach an unrecognized residency", () => {
    const badConfig = { ...configFor(), openAIDataResidency: "apac" } as unknown as LlmCapabilityConfig;
    expect(() => createOpenAIClient(badConfig)).toThrow(ProviderConfigurationError);
  });

  it("never passes config.baseUrl through for a native openai client, even when one is set", async () => {
    const requests = requestsTo();
    const config: LlmCapabilityConfig = { ...configFor("eu"), baseUrl: "https://attacker.example/v1" };

    await new OpenAITextGenerationClient(config).complete({ prompt: "hi" });

    expect(requests).toEqual(["https://eu.api.openai.com/v1/chat/completions"]);
  });

  it("reaches exactly the configured Azure OpenAI endpoint when openAIAzureBaseUrl is set", async () => {
    const requests = requestsTo();
    const config: LlmCapabilityConfig = {
      ...configFor(),
      openAIAzureBaseUrl: "https://radioso-eu-1.openai.azure.com/openai/v1",
    };

    await new OpenAITextGenerationClient(config).complete({ prompt: "hi" });

    expect(requests).toEqual(["https://radioso-eu-1.openai.azure.com/openai/v1/chat/completions"]);
  });

  it("ignores OPENAI_BASE_URL when openAIAzureBaseUrl is set", async () => {
    vi.stubEnv("OPENAI_BASE_URL", "https://attacker.example/v1");
    const requests = requestsTo();
    const config: LlmCapabilityConfig = {
      ...configFor(),
      openAIAzureBaseUrl: "https://radioso-eu-1.openai.azure.com/openai/v1",
    };

    await new OpenAITextGenerationClient(config).complete({ prompt: "hi" });

    expect(requests).toEqual(["https://radioso-eu-1.openai.azure.com/openai/v1/chat/completions"]);
  });

  it("never passes config.baseUrl through for a native openai client when openAIAzureBaseUrl is also set", async () => {
    const requests = requestsTo();
    const config: LlmCapabilityConfig = {
      ...configFor(),
      openAIAzureBaseUrl: "https://radioso-eu-1.openai.azure.com/openai/v1",
      baseUrl: "https://attacker.example/v1",
    };

    await new OpenAITextGenerationClient(config).complete({ prompt: "hi" });

    expect(requests).toEqual(["https://radioso-eu-1.openai.azure.com/openai/v1/chat/completions"]);
  });

  it("prefers openAIAzureBaseUrl over openAIDataResidency when both are somehow set", async () => {
    // Defense in depth: resolveLlmConfig and env.ts both refuse to produce this combination, but
    // the client factory's own precedence must still be unambiguous if a config were ever built
    // by hand with both fields set.
    const requests = requestsTo();
    const config: LlmCapabilityConfig = {
      ...configFor("eu"),
      openAIAzureBaseUrl: "https://radioso-eu-1.openai.azure.com/openai/v1",
    };

    await new OpenAITextGenerationClient(config).complete({ prompt: "hi" });

    expect(requests).toEqual(["https://radioso-eu-1.openai.azure.com/openai/v1/chat/completions"]);
  });
});
