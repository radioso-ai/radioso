import { AppError } from "../../domain/errors.js";
import { ProviderConfigurationError } from "./providerTypes.js";

/**
 * The question a readiness check asks the LLM layer: could the chat inference pipeline resolve a
 * credentialed config for this workspace? That pipeline is what starter pack drafting, directive
 * coherence, and Ray's turns run on. `LlmProviderRegistry` answers it without a model call and
 * without decrypting a key.
 */
export interface ChatPipelineProbe {
  assertChatPipelineResolvable(workspaceId: string): Promise<void>;
}

/**
 * Whether a workspace can make chat model calls. Neither answer exposes the resolved provider,
 * model, base URL, or key.
 */
export interface ChatReadiness {
  /** True when the chat pipeline resolves for the workspace; false for any failure. */
  isChatConfigured(workspaceId: string): Promise<boolean>;
  /** Resolves when the chat pipeline resolves; otherwise throws a 503 `provider_misconfigured`. */
  assertChatConfigured(workspaceId: string): Promise<void>;
}

export const createChatReadiness = (probe: ChatPipelineProbe): ChatReadiness => ({
  async isChatConfigured(workspaceId) {
    try {
      await probe.assertChatPipelineResolvable(workspaceId);
      return true;
    } catch {
      return false;
    }
  },
  async assertChatConfigured(workspaceId) {
    try {
      await probe.assertChatPipelineResolvable(workspaceId);
    } catch (error) {
      // The probe's own error carries the remediation details; any other failure means the same
      // thing to a caller, so it gets the same code.
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
