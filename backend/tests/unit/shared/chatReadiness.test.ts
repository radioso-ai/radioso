import { describe, expect, it, vi } from "vitest";

import { createChatReadiness } from "../../../src/shared/infra/llm/chatReadiness.js";
import { ProviderConfigurationError } from "../../../src/shared/infra/llm/providerTypes.js";

const configuredResolver = () =>
  vi.fn().mockResolvedValue({ provider: "openai", model: "gpt-test", apiKey: "sk-secret-value" });

describe("createChatReadiness", () => {
  describe("isChatConfigured", () => {
    it("is true when the workspace's chat capability resolves", async () => {
      const resolve = configuredResolver();

      await expect(createChatReadiness({ resolve }).isChatConfigured("workspace-1")).resolves.toBe(true);
      expect(resolve).toHaveBeenCalledWith("chat", { workspaceId: "workspace-1" });
    });

    it("is false when the resolver reports a missing provider configuration", async () => {
      const readiness = createChatReadiness({
        resolve: vi.fn().mockRejectedValue(new ProviderConfigurationError("Missing key", { kind: "missing_api_key", capability: "chat" })),
      });

      await expect(readiness.isChatConfigured("workspace-1")).resolves.toBe(false);
    });

    it("is false for any other resolution failure, as Ray's availability check has always treated it", async () => {
      const readiness = createChatReadiness({ resolve: vi.fn().mockRejectedValue(new Error("no resolver")) });

      await expect(readiness.isChatConfigured("workspace-1")).resolves.toBe(false);
    });

    it("returns only a boolean, never the resolved configuration or its key", async () => {
      const result = await createChatReadiness({ resolve: configuredResolver() }).isChatConfigured("workspace-1");

      expect(typeof result).toBe("boolean");
      expect(JSON.stringify(result)).not.toContain("sk-secret-value");
    });
  });

  describe("assertChatConfigured", () => {
    it("passes when the workspace's chat capability resolves", async () => {
      const resolve = configuredResolver();

      await expect(createChatReadiness({ resolve }).assertChatConfigured("workspace-1")).resolves.toBeUndefined();
      expect(resolve).toHaveBeenCalledWith("chat", { workspaceId: "workspace-1" });
    });

    it("rethrows the resolver's own provider configuration error unchanged", async () => {
      const error = new ProviderConfigurationError("Missing key", { kind: "missing_api_key", capability: "chat" });
      const readiness = createChatReadiness({ resolve: vi.fn().mockRejectedValue(error) });

      await expect(readiness.assertChatConfigured("workspace-1")).rejects.toBe(error);
    });

    it("treats any other resolution failure as an unconfigured provider", async () => {
      const readiness = createChatReadiness({ resolve: vi.fn().mockRejectedValue(new Error("no resolver")) });

      await expect(readiness.assertChatConfigured("workspace-1"))
        .rejects.toMatchObject({ statusCode: 503, code: "provider_misconfigured" });
    });
  });
});
