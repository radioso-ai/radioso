import { createHash } from "node:crypto";

import {
  getSupportedEmbeddingModel,
  isSupportedEmbeddingModel,
} from "./supportedEmbeddingModels.js";
import {
  ProviderConfigurationError,
  resolvedProviderEndpointIdentity,
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
          resolvedProviderEndpointIdentity(candidate) === resolvedProviderEndpointIdentity(config),
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

/** Strips the fragment, query, and trailing slash so two equivalent URLs scope identically. */
const normalizedUrlString = (rawUrl: string): string => {
  const url = new URL(rawUrl);
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
};

const normalizedEndpointScope = (config: LlmCapabilityDefault): string => {
  if (config.provider === "openai") {
    // Every native openai endpoint -- OpenAI's own global/US/EU hosts, or an operator's Azure
    // OpenAI deployment -- serves identical model weights. Verified empirically (2026-10-24) for
    // text-embedding-3-small: Azure EU Data Zone vs. OpenAI global, cosine 1.000000, max |diff|
    // 1.2e-4, on English and Italian inputs. A persisted embedding space's fingerprint must
    // therefore stay endpoint-agnostic here, or switching OPENAI_DATA_RESIDENCY or
    // AZURE_OPENAI_ENDPOINT would strand every already-ingested workspace's space with no
    // resolvable binding (resolveEmbeddingProviderBinding would find no candidate at the new
    // fingerprint). Endpoint identity still matters for client caching and candidate dedup --
    // see resolvedProviderEndpointIdentity in providerTypes.ts -- just never for this scope. The
    // scope string itself is unchanged from before data residency or Azure existed, so no
    // already-persisted space's fingerprint ever shifts under it.
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
  return `${config.provider}:${normalizedUrlString(config.baseUrl)}`;
};

export const endpointScopeFingerprint = (
  config: LlmCapabilityDefault,
): string =>
  createHash("sha256")
    .update(normalizedEndpointScope(config))
    .digest("hex");
