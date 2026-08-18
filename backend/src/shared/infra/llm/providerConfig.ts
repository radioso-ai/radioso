import type { Env } from "../../../app/config/env.js";
import {
  type LlmCapabilityDefault,
  type LlmCapabilityName,
  type LlmProviderName,
  ProviderConfigurationError,
  type ResolvedLlmConfig,
} from "./providerTypes.js";

type ProviderEnv = Partial<Env> & Record<string, string | number | boolean | undefined>;

const PROVIDERS: LlmProviderName[] = ["openai", "openai-compatible", "gemini", "claude"];
const DEFAULT_PROVIDER: LlmProviderName = "openai";
const DEFAULT_CHAT_MODEL = "gpt-5.4-mini";
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_GEMINI_EMBEDDING_MODEL = "gemini-embedding-001";
const DEFAULT_GEMINI_TEXT_MODEL = "gemini-2.5-flash";
const DEFAULT_CLAUDE_TEXT_MODEL = "claude-sonnet-4-5";

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

const resolveCapability = (
  capability: LlmCapabilityName,
  provider: LlmProviderName,
  model: string,
  env: ProviderEnv,
): LlmCapabilityDefault => {
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

  return {
    chat,
    rewrite,
    rerank,
    embeddings,
    embeddingProviderConfigs,
    providerApiKeys: Object.fromEntries(
      PROVIDERS.flatMap((provider) => {
        const apiKey = resolveApiKey(provider, env);
        return apiKey ? [[provider, apiKey]] : [];
      }),
    ),
  };
};
