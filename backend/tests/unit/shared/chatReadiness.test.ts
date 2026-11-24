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

    it("propagates any other failure instead of reporting a missing configuration", async () => {
      const failure = new Error("credential store down");
      const readiness = createChatReadiness(probeThat(async () => { throw failure; }));

      await expect(readiness.isChatConfigured("workspace-1")).rejects.toBe(failure);
    });
  });

  describe("assertChatConfigured", () => {
    it("passes when the chat pipeline resolves for the workspace", async () => {
      const probe = probeThat(async () => undefined);

      await expect(createChatReadiness(probe).assertChatConfigured("workspace-1")).resolves.toBeUndefined();
      expect(probe.assertChatPipelineResolvable).toHaveBeenCalledWith("workspace-1");
    });

    it("names the deployment chat provider whose key is missing, not a workspace provider choice", async () => {
      const readiness = createChatReadiness(probeThat(async () => {
        throw new ProviderConfigurationError("Missing key", { kind: "missing_api_key", provider: "claude", capability: "chat" });
      }));

      const error = await readiness.assertChatConfigured("workspace-1").catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ProviderConfigurationError);
      expect(error).toMatchObject({
        statusCode: 503,
        code: "provider_misconfigured",
        details: expect.objectContaining({ kind: "missing_api_key", provider: "claude", capability: "chat" }),
      });
      const { message, details } = error as ProviderConfigurationError & { details: { remediation: string } };
      expect(message).toContain("\"claude\"");
      expect(message).toContain("deployment's chat model");
      expect(details.remediation).toContain("\"claude\"");
    });

    it("rethrows any other provider configuration error unchanged", async () => {
      const error = new ProviderConfigurationError("Unreadable key", { kind: "credential_unreadable", provider: "openai" });
      const readiness = createChatReadiness(probeThat(async () => { throw error; }));

      await expect(readiness.assertChatConfigured("workspace-1")).rejects.toBe(error);
    });

    it("propagates any other failure instead of reporting a missing configuration", async () => {
      const failure = new Error("credential store down");
      const readiness = createChatReadiness(probeThat(async () => { throw failure; }));

      await expect(readiness.assertChatConfigured("workspace-1")).rejects.toBe(failure);
    });
  });
});
