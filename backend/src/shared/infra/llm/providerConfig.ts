import type { Env } from "../../../app/config/env.js";
import {
  type LlmCapabilityConfig,
  type LlmCapabilityName,
  type LlmProviderName,
  ProviderConfigurationError,
  type ResolvedLlmConfig,
} from "./providerTypes.js";

type ProviderEnv = Partial<Env> & Record<string, string | number | undefined>;

const PROVIDERS: LlmProviderName[] = ["openai", "openai-compatible", "gemini", "claude"];
const DEFAULT_PROVIDER: LlmProviderName = "openai";
const DEFAULT_CHAT_MODEL = "gpt-5.2";
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";

const asProvider = (value: string | number | undefined, field: string): LlmProviderName | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || !PROVIDERS.includes(value as LlmProviderName)) {
    throw new ProviderConfigurationError(`Unsupported provider ${String(value)} configured for ${field}`);
  }

  return value as LlmProviderName;
};

const requireString = (value: string | number | undefined, field: string): string => {
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

export const resolveLlmConfig = (env: ProviderEnv): ResolvedLlmConfig => {
  const sharedProvider = asProvider(env.LLM_PROVIDER, "LLM_PROVIDER") ?? DEFAULT_PROVIDER;

  const chatProvider = asProvider(env.LLM_CHAT_PROVIDER, "LLM_CHAT_PROVIDER") ?? sharedProvider;
  const chatModel = String(env.LLM_CHAT_MODEL ?? env.OPENAI_CHAT_MODEL ?? DEFAULT_CHAT_MODEL);
  const chat = resolveCapability("chat", chatProvider, chatModel, env);

  const rewriteProvider = asProvider(env.LLM_REWRITE_PROVIDER, "LLM_REWRITE_PROVIDER") ?? sharedProvider;
  const rewriteModel = String(env.LLM_REWRITE_MODEL ?? env.OPENAI_CHAT_MODEL ?? DEFAULT_CHAT_MODEL);
  const rewrite = resolveCapability("rewrite", rewriteProvider, rewriteModel, env);

  const rerankProvider = asProvider(env.LLM_RERANK_PROVIDER, "LLM_RERANK_PROVIDER") ?? sharedProvider;
  const rerankModel = String(
    env.LLM_RERANK_MODEL ?? env.OPENAI_RERANK_MODEL ?? env.OPENAI_CHAT_MODEL ?? DEFAULT_CHAT_MODEL,
  );
  const rerank = resolveCapability("rerank", rerankProvider, rerankModel, env);

  const embeddingProvider = asProvider(env.LLM_EMBEDDING_PROVIDER, "LLM_EMBEDDING_PROVIDER") ?? sharedProvider;
  const embeddingModel = String(env.LLM_EMBEDDING_MODEL ?? env.OPENAI_VECTOR_MODEL ?? DEFAULT_EMBEDDING_MODEL);
  const embeddings = resolveCapability("embeddings", embeddingProvider, embeddingModel, env);

  return {
    chat,
    rewrite,
    rerank,
    embeddings,
  };
};
