import { describe, expect, it, vi } from "vitest";

import { PlatformAwareWorkspaceModelAvailability } from "../../src/app/composition/workspaceModelAvailability.js";
import { knownModelsByProvider } from "../../src/shared/infra/llm/knownModels.js";
import type { LlmProviderName } from "../../src/shared/infra/llm/providerTypes.js";

// The staging shape: chat and rerank on gpt-5.4-mini, embeddings on text-embedding-3-small, all
// deployed on the Azure resource the platform key reaches.
const azureDefaults = {
  openAIPlatformEndpoint: {
    kind: "azure" as const,
    baseUrl: "https://radioso-eu-1.openai.azure.com/openai/v1",
    deployments: ["gpt-5.4-mini", "text-embedding-3-small"],
  },
};

const keysFor = (...providers: LlmProviderName[]) => ({
  hasCredentials: vi.fn(async (_workspaceId: string, provider: LlmProviderName) => providers.includes(provider)),
});

describe("PlatformAwareWorkspaceModelAvailability", () => {
  it("lists the catalog models the Azure key serves, never an embedding deployment", async () => {
    const availability = new PlatformAwareWorkspaceModelAvailability({ defaults: azureDefaults, credentials: keysFor() });

    expect(await availability.runnableModels("ws-1", "openai")).toEqual(["gpt-5.4-mini"]);
  });

  it("lifts the restriction for a workspace holding its own key for the provider", async () => {
    const availability = new PlatformAwareWorkspaceModelAvailability({
      defaults: azureDefaults,
      credentials: keysFor("openai"),
    });

    expect(await availability.runnableModels("ws-1", "openai")).toBeNull();
    expect(await availability.canRun("ws-1", "openai", "gpt-5.4-nano")).toBe(true);
  });

  it("leaves unrestricted providers unrestricted without looking up keys", async () => {
    const credentials = keysFor();
    const availability = new PlatformAwareWorkspaceModelAvailability({ defaults: azureDefaults, credentials });

    expect(await availability.runnableModels("ws-1", "claude")).toBeNull();
    expect(await availability.canRun("ws-1", "openai", "gpt-5.4-mini")).toBe(true);
    expect(credentials.hasCredentials).not.toHaveBeenCalled();
  });

  it("cannot run an undeployed model on the shared key", async () => {
    const availability = new PlatformAwareWorkspaceModelAvailability({ defaults: azureDefaults, credentials: keysFor() });

    expect(await availability.canRun("ws-1", "openai", "gpt-5.4-nano")).toBe(false);
  });

  it("runs every catalog model on OpenAI's own hosts", async () => {
    const availability = new PlatformAwareWorkspaceModelAvailability({
      defaults: { openAIPlatformEndpoint: { kind: "openai", residency: "eu" } },
      credentials: keysFor(),
    });

    expect(await availability.runnableModels("ws-1", "openai")).toBeNull();
    expect(knownModelsByProvider.openai).toContain("gpt-5.4-nano");
  });
});
