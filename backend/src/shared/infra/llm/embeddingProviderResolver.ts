import { createHash } from "node:crypto";

import {
  getSupportedEmbeddingModel,
  isSupportedEmbeddingModel,
} from "./supportedEmbeddingModels.js";
import {
  ProviderConfigurationError,
  type LlmCapabilityDefault,
} from "./providerTypes.js";
import type {
  EmbeddingProviderImplementation,
} from "../../../modules/embeddingProfiles/contracts/embeddingProvider.js";

export type EmbeddingCapabilityConfig = LlmCapabilityDefault & {
  provider: EmbeddingProviderImplementation;
};

export interface EmbeddingProviderBindingSelection {
  readonly provider?: EmbeddingProviderImplementation;
  readonly endpointScopeFingerprint?: string;
}

const isEmbeddingProvider = (
  config: LlmCapabilityDefault,
): config is EmbeddingCapabilityConfig =>
  config.provider === "openai" ||
  config.provider === "openai-compatible" ||
  config.provider === "gemini";

const supportsDescriptor = (
  config: LlmCapabilityDefault,
  family: "openai_like" | "gemini",
): boolean =>
  family === "gemini"
    ? config.provider === "gemini"
    : config.provider === "openai" ||
      config.provider === "openai-compatible";

export const resolveEmbeddingProviderBinding = (
  model: string,
  primary: LlmCapabilityDefault,
  configured: readonly LlmCapabilityDefault[],
  requestedBinding?: EmbeddingProviderBindingSelection,
  options: { readonly acceptExistingSelection?: boolean } = {},
): EmbeddingCapabilityConfig => {
  if (
    !isSupportedEmbeddingModel(model)
    && !options.acceptExistingSelection
  ) {
    getSupportedEmbeddingModel(model);
  }
  const descriptor = isSupportedEmbeddingModel(model)
    ? getSupportedEmbeddingModel(model)
    : null;
  const candidates = [primary, ...configured]
    .filter(isEmbeddingProvider)
    .filter(
      (config, index, all) =>
        all.findIndex(
        (candidate) =>
          candidate.provider === config.provider &&
          candidate.baseUrl === config.baseUrl,
        ) === index,
    );
  const hasRequestedBinding = Boolean(
    requestedBinding?.provider
    || requestedBinding?.endpointScopeFingerprint,
  );
  const requested = hasRequestedBinding
    ? candidates.find((candidate) =>
        (!requestedBinding?.provider
          || candidate.provider === requestedBinding.provider)
        && (!requestedBinding?.endpointScopeFingerprint
          || endpointScopeFingerprint(candidate)
            === requestedBinding.endpointScopeFingerprint))
    : undefined;
  const primaryEmbedding = isEmbeddingProvider(primary)
    ? primary
    : undefined;
  const resolved =
    hasRequestedBinding
      ? requested
      : (
          primaryEmbedding &&
          (
            !descriptor
            || supportsDescriptor(primaryEmbedding, descriptor.providerFamily)
          )
            ? primaryEmbedding
            : candidates.find((candidate) =>
                descriptor
                && supportsDescriptor(candidate, descriptor.providerFamily),
              )
        );

  if (
    !resolved ||
    (
      descriptor
      && !supportsDescriptor(resolved, descriptor.providerFamily)
    ) ||
    (requestedBinding?.provider
      && resolved.provider !== requestedBinding.provider)
    || (requestedBinding?.endpointScopeFingerprint
      && endpointScopeFingerprint(resolved)
        !== requestedBinding.endpointScopeFingerprint)
  ) {
    throw new ProviderConfigurationError(
      `No configured embedding provider can serve model ${model}`,
    );
  }
  return resolved;
};

const normalizedEndpointScope = (config: LlmCapabilityDefault): string => {
  if (config.provider === "openai") {
    return "openai:public-api";
  }
  if (config.provider === "gemini") {
    return "gemini:public-api";
  }
  if (config.provider !== "openai-compatible" || !config.baseUrl) {
    throw new ProviderConfigurationError(
      `Provider ${config.provider} has no embedding endpoint scope`,
    );
  }
  const url = new URL(config.baseUrl);
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return `${config.provider}:${url.toString()}`;
};

export const endpointScopeFingerprint = (
  config: LlmCapabilityDefault,
): string =>
  createHash("sha256")
    .update(normalizedEndpointScope(config))
    .digest("hex");
