import type { Env } from "../../../app/config/env.js";
import {
  type LlmCapabilityConfig,
  type LlmCapabilityName,
  type LlmProviderName,
  ProviderConfigurationError,
  type ResolvedLlmConfig,
} from "./providerTypes.js";

type ProviderEnv = Partial<Env> & Record<string, string | number | boolean | undefined>;

const PROVIDERS: LlmProviderName[] = ["openai", "openai-compatible", "gemini", "claude"];
const DEFAULT_PROVIDER: LlmProviderName = "openai";
const DEFAULT_CHAT_MODEL = "gpt-5.2";
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
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

const resolveApiKey = (provider: LlmProviderName, env: ProviderEnv): string => {
  switch (provider) {
    case "openai":
      return requireString(env.OPENAI_API_KEY, "OPENAI_API_KEY");
    case "openai-compatible":
      return requireString(env.OPENAI_COMPATIBLE_API_KEY ?? env.OPENAI_API_KEY, "OPENAI_COMPATIBLE_API_KEY");
    case "gemini":
      return requireString(env.GEMINI_API_KEY, "GEMINI_API_KEY");
    case "claude":
      return requireString(env.ANTHROPIC_API_KEY, "ANTHROPIC_API_KEY");
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
): LlmCapabilityConfig => ({
  capability,
  provider,
  model,
  apiKey: resolveApiKey(provider, env),
  baseUrl: resolveBaseUrl(provider, env),
});

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

  return provider === "gemini" ? "gemini-embedding-001" : DEFAULT_CLAUDE_TEXT_MODEL;
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

  const embeddingProvider = asProvider(env.LLM_EMBEDDING_PROVIDER, "LLM_EMBEDDING_PROVIDER") ?? DEFAULT_PROVIDER;
  const embeddingModel = resolveEmbeddingModel(embeddingProvider, env.LLM_EMBEDDING_MODEL, env.OPENAI_VECTOR_MODEL);
  const embeddings = resolveCapability("embeddings", embeddingProvider, embeddingModel, env);

  return {
    chat,
    rewrite,
    rerank,
    embeddings,
  };
};
