import { ProviderConfigurationError } from "./providerTypes.js";

/**
 * The question a readiness check asks the LLM layer: could the chat inference pipeline resolve a
 * credentialed config for this workspace? That pipeline runs the deployment's chat model (its
 * provider and model, with the workspace's key for that provider or the deployment's), whatever
 * provider the workspace chose for its own agents. Starter pack drafting, directive coherence, and
 * Ray's turns run on it. `LlmProviderRegistry` answers without a model call.
 */
export interface ChatPipelineProbe {
  assertChatPipelineResolvable(workspaceId: string): Promise<void>;
}

/**
 * Whether a workspace can make chat model calls. Neither answer exposes the resolved model, base
 * URL, or key. Only a provider configuration error means "not configured"; any other failure
 * (a database read, say) propagates as itself.
 */
export interface ChatReadiness {
  /** True when the chat pipeline resolves for the workspace; false when its configuration is incomplete. */
  isChatConfigured(workspaceId: string): Promise<boolean>;
  /** Resolves when the chat pipeline resolves; otherwise throws a 503 `provider_misconfigured`. */
  assertChatConfigured(workspaceId: string): Promise<void>;
}

/** A missing key here is for the deployment's chat provider, which the workspace's own provider choice does not change. */
const forDeploymentChatModel = (error: ProviderConfigurationError): ProviderConfigurationError => {
  const { kind, provider, capability } = error.details;
  if (kind !== "missing_api_key" || !provider) {
    return error;
  }
  return new ProviderConfigurationError(
    `This runs on the deployment's chat model, from provider "${provider}", and no API key for "${provider}" is available to this workspace.`,
    {
      kind,
      provider,
      ...(capability ? { capability } : {}),
      remediation: `Add a workspace credential for "${provider}" at Settings → Credentials, or set the deployment's key for "${provider}" and restart Radioso.`,
    },
  );
};

export const createChatReadiness = (probe: ChatPipelineProbe): ChatReadiness => ({
  async isChatConfigured(workspaceId) {
    try {
      await probe.assertChatPipelineResolvable(workspaceId);
      return true;
    } catch (error) {
      if (error instanceof ProviderConfigurationError) {
        return false;
      }
      throw error;
    }
  },
  async assertChatConfigured(workspaceId) {
    try {
      await probe.assertChatPipelineResolvable(workspaceId);
    } catch (error) {
      throw error instanceof ProviderConfigurationError ? forDeploymentChatModel(error) : error;
    }
  },
});
