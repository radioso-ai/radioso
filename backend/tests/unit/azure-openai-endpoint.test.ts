import { describe, expect, it } from "vitest";

import {
  isAzureOpenAIHost,
  isNormalizableAzureOpenAIPath,
  normalizeAzureOpenAIEndpoint,
} from "../../src/shared/infra/llm/azureOpenAIEndpoint.js";

describe("isAzureOpenAIHost", () => {
  it("accepts an Azure OpenAI resource host", () => {
    expect(isAzureOpenAIHost("radioso-eu-1.openai.azure.com")).toBe(true);
  });

  it("accepts an Azure AI Foundry resource host", () => {
    expect(isAzureOpenAIHost("radioso-eu-1.services.ai.azure.com")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isAzureOpenAIHost("Radioso-EU-1.OPENAI.AZURE.COM")).toBe(true);
  });

  it("rejects OpenAI's own hosts and arbitrary hosts", () => {
    expect(isAzureOpenAIHost("api.openai.com")).toBe(false);
    expect(isAzureOpenAIHost("eu.api.openai.com")).toBe(false);
    expect(isAzureOpenAIHost("attacker.example.com")).toBe(false);
  });

  it("rejects a host that merely contains the suffix as a prefix trick", () => {
    expect(isAzureOpenAIHost("openai.azure.com.attacker.example")).toBe(false);
  });
});

describe("isNormalizableAzureOpenAIPath", () => {
  it("accepts the bare path, with or without a trailing slash", () => {
    expect(isNormalizableAzureOpenAIPath("")).toBe(true);
    expect(isNormalizableAzureOpenAIPath("/")).toBe(true);
  });

  it("accepts /openai/v1, with or without a trailing slash", () => {
    expect(isNormalizableAzureOpenAIPath("/openai/v1")).toBe(true);
    expect(isNormalizableAzureOpenAIPath("/openai/v1/")).toBe(true);
  });

  it("rejects any other path", () => {
    expect(isNormalizableAzureOpenAIPath("/openai/v2")).toBe(false);
    expect(isNormalizableAzureOpenAIPath("/something-else")).toBe(false);
  });
});

describe("normalizeAzureOpenAIEndpoint", () => {
  it("appends /openai/v1 to the bare resource host", () => {
    expect(normalizeAzureOpenAIEndpoint("https://radioso-eu-1.openai.azure.com")).toBe(
      "https://radioso-eu-1.openai.azure.com/openai/v1",
    );
  });

  it("strips a trailing slash on the bare host", () => {
    expect(normalizeAzureOpenAIEndpoint("https://radioso-eu-1.openai.azure.com/")).toBe(
      "https://radioso-eu-1.openai.azure.com/openai/v1",
    );
  });

  it("leaves an already-correct endpoint unchanged", () => {
    expect(normalizeAzureOpenAIEndpoint("https://radioso-eu-1.openai.azure.com/openai/v1")).toBe(
      "https://radioso-eu-1.openai.azure.com/openai/v1",
    );
  });

  it("strips a trailing slash on the full path", () => {
    expect(normalizeAzureOpenAIEndpoint("https://radioso-eu-1.openai.azure.com/openai/v1/")).toBe(
      "https://radioso-eu-1.openai.azure.com/openai/v1",
    );
  });
});
