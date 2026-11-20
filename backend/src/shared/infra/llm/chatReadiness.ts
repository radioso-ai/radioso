import { AppError } from "../../domain/errors.js";
import { ProviderConfigurationError } from "./providerTypes.js";
import type { LlmCapabilityResolveInput } from "./workspaceContext.js";

/** All a readiness check needs from the capability resolver; its resolved value is never read. */
export interface ChatCapabilityProbe {
  resolve(capability: "chat", input: LlmCapabilityResolveInput): Promise<unknown>;
}

/**
 * Whether a workspace can make chat model calls. Both answers come from resolving the workspace's
 * `chat` capability, the same check Ray's availability endpoint has always made. Neither exposes
 * the resolved provider, model, base URL, or key.
 */
export interface ChatReadiness {
  /** True when the chat capability resolves for the workspace; false for any failure. */
  isChatConfigured(workspaceId: string): Promise<boolean>;
  /** Resolves when the chat capability resolves; otherwise throws a 503 `provider_misconfigured`. */
  assertChatConfigured(workspaceId: string): Promise<void>;
}

export const createChatReadiness = (resolver: ChatCapabilityProbe): ChatReadiness => ({
  async isChatConfigured(workspaceId) {
    try {
      await resolver.resolve("chat", { workspaceId });
      return true;
    } catch {
      return false;
    }
  },
  async assertChatConfigured(workspaceId) {
    try {
      await resolver.resolve("chat", { workspaceId });
    } catch (error) {
      // The resolver's own error carries the remediation details; any other resolution failure
      // means the same thing to a caller, so it gets the same code.
      if (error instanceof AppError) {
        throw error;
      }
      throw new ProviderConfigurationError("No language model is configured for this workspace.", {
        capability: "chat",
        remediation: "Configure a chat model provider in the workspace's provider settings.",
      });
    }
  },
});
