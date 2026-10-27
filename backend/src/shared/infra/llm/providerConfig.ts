import type { Env } from "../../../app/config/env.js";
import {
  type LlmCapabilityDefault,
  type LlmCapabilityName,
  type LlmProviderName,
  OPENAI_DATA_RESIDENCIES,
  type OpenAIDataResidency,
  platformOpenAIEndpointFields,
  type PlatformOpenAIEndpoint,
  ProviderConfigurationError,
  type ResolvedLlmConfig,
} from "./providerTypes.js";

type ProviderEnv = Partial<Env> & Record<string, string | number | boolean | undefined> & {
  OPENAI_DATA_RESIDENCY?: OpenAIDataResidency;
  AZURE_OPENAI_ENDPOINT?: string;
};

const PROVIDERS: LlmProviderName[] = ["openai", "openai-compatible", "gemini", "claude"];
const DEFAULT_PROVIDER: LlmProviderName = "openai";
const DEFAULT_CHAT_MODEL = "gpt-5.4-mini";
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_GEMINI_EMBEDDING_MODEL = "gemini-embedding-001";
const DEFAULT_GEMINI_TEXT_MODEL = "gemini-2.5-flash";
const DEFAULT_CLAUDE_TEXT_MODEL = "claude-sonnet-4-5";

/**
 * Validates the platform's OpenAI data-residency setting against the one allowed list
 * (`OPENAI_DATA_RESIDENCIES`). An unset value is the documented default, `global`; any other
 * value this module does not recognize is a configuration error, not something to coerce —
 * this is a compliance setting, so it fails closed rather than silently falling back to the
 * global endpoint an operator explicitly moved away from.
 */
const requireOpenAIDataResidency = (value: OpenAIDataResidency | undefined): OpenAIDataResidency => {
  if (value === undefined) {
    return "global";
  }
  if (!(OPENAI_DATA_RESIDENCIES as readonly string[]).includes(value)) {
    throw new ProviderConfigurationError(`Unsupported OPENAI_DATA_RESIDENCY value "${String(value)}"`);
  }
  return value;
};

/**
 * Combines the platform's validated residency with an optional `AZURE_OPENAI_ENDPOINT` into the
 * one {@link PlatformOpenAIEndpoint} value this module, `WorkspaceLlmCapabilityResolver`, and the
 * residency startup probe all read. `env.ts`'s own `superRefine` already rejects this same
 * combination at startup for a deployment that goes through `getEnv`; this redundant check is
 * defense in depth for `resolveLlmConfig` callers (including tests) that build a `ProviderEnv`
 * by hand rather than through `getEnv`.
 */
const requirePlatformOpenAIEndpoint = (
  residency: OpenAIDataResidency,
  azureEndpoint: string | undefined,
  capabilityDefaults: PlatformCapabilityDefaults,
): PlatformOpenAIEndpoint => {
  if (!azureEndpoint) {
    return { kind: "openai", residency };
  }
  if (residency !== "global") {
    throw new ProviderConfigurationError(
      `AZURE_OPENAI_ENDPOINT cannot be combined with OPENAI_DATA_RESIDENCY=${residency}; Azure OpenAI is reached only at the default (global) residency.`,
    );
  }
  const deployments = [...new Set(platformOpenAIModelCalls(capabilityDefaults).map((call) => call.model))];
  return { kind: "azure", baseUrl: azureEndpoint, deployments };
};

type PlatformCapabilityDefaults = Pick<
  ResolvedLlmConfig,
  "chat" | "rewrite" | "rerank" | "embeddings" | "embeddingProviderConfigs"
>;

/** Every capability `ResolvedLlmConfig` carries a default for — iterated generically so a
 *  capability can never be silently left out of the platform's model calls. */
const ALL_CAPABILITY_NAMES: readonly LlmCapabilityName[] = ["chat", "rewrite", "rerank", "embeddings"];

/**
 * Every (capability, model) the platform-held OpenAI key is configured to call: each capability
 * default on native `openai`, plus the supplemental openai embedding config even when the
 * primary embeddings provider is not openai — `resolveLlmConfig` keeps an openai-embeddings
 * capability latently available alongside a platform key, since a workspace or an embedding
 * profile can request it explicitly at any time. The one list both the Azure endpoint's
 * `deployments` and the residency startup probe's targets are derived from, so the models the
 * platform serves and the models startup verifies are the same set.
 */
export const platformOpenAIModelCalls = (
  defaults: PlatformCapabilityDefaults,
): Array<{ capability: LlmCapabilityName; model: string }> => {
  const calls = ALL_CAPABILITY_NAMES.flatMap((capability) =>
    defaults[capability].provider === "openai" ? [{ capability, model: defaults[capability].model }] : [],
  );
  const supplementalEmbeddingModel = defaults.embeddingProviderConfigs.find(
    (entry) => entry.provider === "openai",
  )?.model;
  return supplementalEmbeddingModel
    ? [...calls, { capability: "embeddings", model: supplementalEmbeddingModel }]
    : calls;
};

const asProvider = (value: string | number | boolean | undefined, field: string): LlmProviderName | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || !PROVIDERS.includes(value as LlmProviderName)) {
    throw new ProviderConfigurationError(`Unsupported provider ${String(value)} configured for ${field}`);
  }

  return value as LlmProviderName;
};

const requireString = (value: string | number | boolean | undefined, field: string): string => {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  throw new ProviderConfigurationError(`Missing required configuration: ${field}`);
};

const resolveApiKey = (provider: LlmProviderName, env: ProviderEnv): string | undefined => {
  switch (provider) {
    case "openai":
      return typeof env.OPENAI_API_KEY === "string" && env.OPENAI_API_KEY.trim()
        ? env.OPENAI_API_KEY.trim()
        : undefined;
    case "openai-compatible":
      return typeof (env.OPENAI_COMPATIBLE_API_KEY ?? env.OPENAI_API_KEY) === "string"
        && String(env.OPENAI_COMPATIBLE_API_KEY ?? env.OPENAI_API_KEY).trim()
        ? String(env.OPENAI_COMPATIBLE_API_KEY ?? env.OPENAI_API_KEY).trim()
        : undefined;
    case "gemini":
      return typeof env.GEMINI_API_KEY === "string" && env.GEMINI_API_KEY.trim()
        ? env.GEMINI_API_KEY.trim()
        : undefined;
    case "claude":
      return typeof env.ANTHROPIC_API_KEY === "string" && env.ANTHROPIC_API_KEY.trim()
        ? env.ANTHROPIC_API_KEY.trim()
        : undefined;
  }
};

const resolveBaseUrl = (provider: LlmProviderName, env: ProviderEnv): string | undefined => {
  if (provider !== "openai-compatible") {
    return undefined;
  }

  return requireString(env.OPENAI_COMPATIBLE_BASE_URL, "OPENAI_COMPATIBLE_BASE_URL");
};

/**
 * Stamps a native `openai` capability default with the fields of its resolved platform
 * endpoint; other providers pass through. The fields are omitted entirely at the default
 * (`global`) residency, matching `baseUrl`'s own present-only-when-it-matters convention — a
 * workspace's (BYOK) key never reaches this module at all, so there is no "ignore it for BYOK"
 * branch to keep in sync here.
 *
 * `platformEndpoint` is the single value `resolveLlmConfig` already derived from env; passing
 * it in means every capability default agrees with `ResolvedLlmConfig.openAIPlatformEndpoint`
 * and with what `WorkspaceLlmCapabilityResolver` would actually use — never stamping an endpoint
 * where nothing downstream would read it.
 */
const withPlatformEndpointFields = (
  platformEndpoint: PlatformOpenAIEndpoint | undefined,
) => (capabilityDefault: LlmCapabilityDefault): LlmCapabilityDefault =>
  capabilityDefault.provider === "openai" && platformEndpoint
    ? { ...capabilityDefault, ...platformOpenAIEndpointFields(platformEndpoint) }
    : capabilityDefault;

const resolveCapability = (
  capability: LlmCapabilityName,
  provider: LlmProviderName,
  model: string,
  env: ProviderEnv,
): LlmCapabilityDefault => {
  if (provider === "openai") {
    return { capability, provider, model };
  }
  const baseUrl = resolveBaseUrl(provider, env);
  return {
    capability,
    provider,
    model,
    ...(baseUrl ? { baseUrl } : {}),
  };
};

const resolveTextModel = (
  provider: LlmProviderName,
  overrideValue: string | number | boolean | undefined,
  legacyOpenAiValue: string | number | boolean | undefined,
): string => {
  if (typeof overrideValue === "string" && overrideValue.trim().length > 0) {
    return overrideValue.trim();
  }

  if ((provider === "openai" || provider === "openai-compatible") && typeof legacyOpenAiValue === "string" && legacyOpenAiValue.trim().length > 0) {
    return legacyOpenAiValue.trim();
  }

  switch (provider) {
    case "openai":
    case "openai-compatible":
      return DEFAULT_CHAT_MODEL;
    case "gemini":
      return DEFAULT_GEMINI_TEXT_MODEL;
    case "claude":
      return DEFAULT_CLAUDE_TEXT_MODEL;
  }
};

const resolveEmbeddingModel = (
  provider: LlmProviderName,
  overrideValue: string | number | boolean | undefined,
  legacyOpenAiValue: string | number | boolean | undefined,
): string => {
  if (typeof overrideValue === "string" && overrideValue.trim().length > 0) {
    return overrideValue.trim();
  }

  if ((provider === "openai" || provider === "openai-compatible") && typeof legacyOpenAiValue === "string" && legacyOpenAiValue.trim().length > 0) {
    return legacyOpenAiValue.trim();
  }

  if (provider === "openai" || provider === "openai-compatible") {
    return DEFAULT_EMBEDDING_MODEL;
  }

  return provider === "gemini" ? DEFAULT_GEMINI_EMBEDDING_MODEL : DEFAULT_CLAUDE_TEXT_MODEL;
};

const hasRequiredProviderCredentials = (provider: LlmProviderName, env: ProviderEnv): boolean => {
  switch (provider) {
    case "openai":
      return typeof env.OPENAI_API_KEY === "string" && env.OPENAI_API_KEY.trim().length > 0;
    case "openai-compatible":
      return (
        typeof (env.OPENAI_COMPATIBLE_API_KEY ?? env.OPENAI_API_KEY) === "string" &&
        String(env.OPENAI_COMPATIBLE_API_KEY ?? env.OPENAI_API_KEY).trim().length > 0 &&
        typeof env.OPENAI_COMPATIBLE_BASE_URL === "string" &&
        env.OPENAI_COMPATIBLE_BASE_URL.trim().length > 0
      );
    case "gemini":
      return typeof env.GEMINI_API_KEY === "string" && env.GEMINI_API_KEY.trim().length > 0;
    case "claude":
      return typeof env.ANTHROPIC_API_KEY === "string" && env.ANTHROPIC_API_KEY.trim().length > 0;
  }
};

const resolveSupplementalEmbeddingConfigs = (
  primary: LlmCapabilityDefault,
  env: ProviderEnv,
): LlmCapabilityDefault[] => {
  const configs = new Map<LlmProviderName, LlmCapabilityDefault>();
  configs.set(primary.provider, primary);

  if (!configs.has("openai") && hasRequiredProviderCredentials("openai", env)) {
    const model = resolveEmbeddingModel("openai", undefined, env.OPENAI_VECTOR_MODEL);
    configs.set("openai", resolveCapability("embeddings", "openai", model, env));
  }

  if (!configs.has("openai-compatible") && hasRequiredProviderCredentials("openai-compatible", env)) {
    const model = resolveEmbeddingModel("openai-compatible", undefined, env.OPENAI_VECTOR_MODEL);
    configs.set("openai-compatible", resolveCapability("embeddings", "openai-compatible", model, env));
  }

  if (!configs.has("gemini") && hasRequiredProviderCredentials("gemini", env)) {
    configs.set("gemini", resolveCapability("embeddings", "gemini", DEFAULT_GEMINI_EMBEDDING_MODEL, env));
  }

  return [...configs.values()];
};

export const resolveLlmConfig = (env: ProviderEnv): ResolvedLlmConfig => {
  const sharedProvider = asProvider(env.LLM_PROVIDER, "LLM_PROVIDER") ?? DEFAULT_PROVIDER;

  const chatProvider = asProvider(env.LLM_CHAT_PROVIDER, "LLM_CHAT_PROVIDER") ?? sharedProvider;
  const chatModel = resolveTextModel(chatProvider, env.LLM_CHAT_MODEL, env.OPENAI_CHAT_MODEL);
  const chat = resolveCapability("chat", chatProvider, chatModel, env);

  const rewriteProvider = asProvider(env.LLM_REWRITE_PROVIDER, "LLM_REWRITE_PROVIDER") ?? sharedProvider;
  const rewriteModel = resolveTextModel(rewriteProvider, env.LLM_REWRITE_MODEL, env.OPENAI_CHAT_MODEL);
  const rewrite = resolveCapability("rewrite", rewriteProvider, rewriteModel, env);

  const rerankProvider = asProvider(env.LLM_RERANK_PROVIDER, "LLM_RERANK_PROVIDER") ?? sharedProvider;
  const rerankModel = resolveTextModel(rerankProvider, env.LLM_RERANK_MODEL, env.OPENAI_RERANK_MODEL ?? env.OPENAI_CHAT_MODEL);
  const rerank = resolveCapability("rerank", rerankProvider, rerankModel, env);

  const defaultEmbeddingProvider = sharedProvider === "claude" ? DEFAULT_PROVIDER : sharedProvider;
  const embeddingProvider = asProvider(env.LLM_EMBEDDING_PROVIDER, "LLM_EMBEDDING_PROVIDER")
    ?? defaultEmbeddingProvider;
  const embeddingModel = resolveEmbeddingModel(embeddingProvider, env.LLM_EMBEDDING_MODEL, env.OPENAI_VECTOR_MODEL);
  const embeddings = resolveCapability("embeddings", embeddingProvider, embeddingModel, env);
  const embeddingProviderConfigs = resolveSupplementalEmbeddingConfigs(embeddings, env);

  // Derived once, here, from the raw env values and the capability defaults above: every
  // stamped capability default, and ResolvedLlmConfig.openAIPlatformEndpoint, agree with this
  // single value instead of each re-reading or re-validating OPENAI_DATA_RESIDENCY /
  // AZURE_OPENAI_ENDPOINT on their own.
  const platformEndpoint = hasRequiredProviderCredentials("openai", env)
    ? requirePlatformOpenAIEndpoint(
      requireOpenAIDataResidency(env.OPENAI_DATA_RESIDENCY),
      env.AZURE_OPENAI_ENDPOINT,
      { chat, rewrite, rerank, embeddings, embeddingProviderConfigs },
    )
    : undefined;
  const stamp = withPlatformEndpointFields(platformEndpoint);

  return {
    chat: stamp(chat),
    rewrite: stamp(rewrite),
    rerank: stamp(rerank),
    embeddings: stamp(embeddings),
    embeddingProviderConfigs: embeddingProviderConfigs.map(stamp),
    providerApiKeys: Object.fromEntries(
      PROVIDERS.flatMap((provider) => {
        const apiKey = resolveApiKey(provider, env);
        return apiKey ? [[provider, apiKey]] : [];
      }),
    ),
    ...(platformEndpoint ? { openAIPlatformEndpoint: platformEndpoint } : {}),
  };
};
