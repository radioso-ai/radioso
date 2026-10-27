import { describe, expect, it } from "vitest";

import { platformModelAvailability } from "../../src/shared/infra/llm/platformModelAvailability.js";

const azure = {
  openAIPlatformEndpoint: {
    kind: "azure" as const,
    baseUrl: "https://radioso-eu-1.openai.azure.com/openai/v1",
    deployments: ["gpt-5.4-mini", "text-embedding-3-small"],
  },
};

describe("platformModelAvailability", () => {
  it("serves only the Azure deployments for openai when the platform key is an Azure key", () => {
    const availability = platformModelAvailability(azure);

    expect(availability.servedModels("openai")).toEqual(["gpt-5.4-mini", "text-embedding-3-small"]);
    expect(availability.serves("openai", "gpt-5.4-mini")).toBe(true);
    expect(availability.serves("openai", "gpt-5.4-nano")).toBe(false);
  });

  it("leaves every other provider unrestricted on an Azure platform", () => {
    const availability = platformModelAvailability(azure);

    for (const provider of ["claude", "gemini", "openai-compatible"] as const) {
      expect(availability.servedModels(provider)).toBeNull();
      expect(availability.serves(provider, "any-model")).toBe(true);
    }
  });

  it("leaves openai unrestricted on OpenAI's own hosts, at any residency", () => {
    for (const residency of ["global", "us", "eu"] as const) {
      const availability = platformModelAvailability({ openAIPlatformEndpoint: { kind: "openai", residency } });
      expect(availability.servedModels("openai")).toBeNull();
      expect(availability.serves("openai", "gpt-5.4-nano")).toBe(true);
    }
  });

  it("leaves openai unrestricted when no platform OpenAI key is configured", () => {
    const availability = platformModelAvailability({});

    expect(availability.servedModels("openai")).toBeNull();
    expect(availability.serves("openai", "gpt-5.4-nano")).toBe(true);
  });
});
