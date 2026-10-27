import type { LlmProviderName, ResolvedLlmConfig } from "./providerTypes.js";

/**
 * Which models a call made with a platform-held provider key can reach. Only an Azure platform
 * endpoint restricts anything — Azure resolves the request's `model` to a deployment by name,
 * and only the platform defaults are deployed. OpenAI's own hosts and every other provider serve
 * whatever model the provider offers.
 */
export interface PlatformModelAvailability {
  /** Whether the platform key for `provider` can serve `model`. */
  serves(provider: LlmProviderName, model: string): boolean;
  /** The only models the platform key for `provider` serves; `null` when it serves every model. */
  servedModels(provider: LlmProviderName): readonly string[] | null;
}

export const platformModelAvailability = (
  config: Pick<ResolvedLlmConfig, "openAIPlatformEndpoint">,
): PlatformModelAvailability => {
  const endpoint = config.openAIPlatformEndpoint;
  const openAIDeployments = endpoint?.kind === "azure" ? endpoint.deployments : null;
  const servedModels = (provider: LlmProviderName): readonly string[] | null =>
    provider === "openai" ? openAIDeployments : null;
  return {
    servedModels,
    serves(provider, model) {
      const served = servedModels(provider);
      return served === null || served.includes(model);
    },
  };
};
