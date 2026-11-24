import { describe, expect, it, vi } from "vitest";

import { createChatReadiness } from "../../../src/shared/infra/llm/chatReadiness.js";
import { ProviderConfigurationError } from "../../../src/shared/infra/llm/providerTypes.js";

const probeThat = (outcome: () => Promise<void>) => ({ assertChatPipelineResolvable: vi.fn(outcome) });

describe("createChatReadiness", () => {
  describe("isChatConfigured", () => {
    it("is true when the chat pipeline resolves for the workspace", async () => {
      const probe = probeThat(async () => undefined);

      await expect(createChatReadiness(probe).isChatConfigured("workspace-1")).resolves.toBe(true);
      expect(probe.assertChatPipelineResolvable).toHaveBeenCalledWith("workspace-1");
    });

    it("is false when the pipeline reports a missing provider configuration", async () => {
      const readiness = createChatReadiness(probeThat(async () => {
        throw new ProviderConfigurationError("Missing key", { kind: "missing_api_key", capability: "chat" });
      }));

      await expect(readiness.isChatConfigured("workspace-1")).resolves.toBe(false);
    });

    it("is false for any other failure", async () => {
      const readiness = createChatReadiness(probeThat(async () => { throw new Error("credential store down"); }));

      await expect(readiness.isChatConfigured("workspace-1")).resolves.toBe(false);
    });
  });

  describe("assertChatConfigured", () => {
    it("passes when the chat pipeline resolves for the workspace", async () => {
      const probe = probeThat(async () => undefined);

      await expect(createChatReadiness(probe).assertChatConfigured("workspace-1")).resolves.toBeUndefined();
      expect(probe.assertChatPipelineResolvable).toHaveBeenCalledWith("workspace-1");
    });

    it("rethrows the pipeline's own provider configuration error unchanged", async () => {
      const error = new ProviderConfigurationError("Missing key", { kind: "missing_api_key", capability: "chat" });
      const readiness = createChatReadiness(probeThat(async () => { throw error; }));

      await expect(readiness.assertChatConfigured("workspace-1")).rejects.toBe(error);
    });

    it("treats any other failure as an unconfigured provider", async () => {
      const readiness = createChatReadiness(probeThat(async () => { throw new Error("credential store down"); }));

      await expect(readiness.assertChatConfigured("workspace-1"))
        .rejects.toMatchObject({ statusCode: 503, code: "provider_misconfigured" });
    });
  });
});
