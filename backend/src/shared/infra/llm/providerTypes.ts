export type LlmProviderName = "openai" | "openai-compatible" | "gemini" | "claude";
export type LlmCapabilityName = "chat" | "rewrite" | "rerank" | "embeddings";

export interface LlmProviderMetadata {
  capability: LlmCapabilityName;
  provider: LlmProviderName;
  model: string;
}

export interface TextGenerationRequest {
  prompt: string;
  systemPrompt?: string;
  temperature?: number;
  maxOutputTokens?: number;
}

export interface TextGenerationClient {
  readonly metadata: LlmProviderMetadata;
  complete(input: TextGenerationRequest): Promise<string>;
  stream(input: TextGenerationRequest): AsyncIterable<string>;
}

export interface EmbeddingClient {
  readonly metadata: LlmProviderMetadata;
  embedTexts(texts: string[], options?: { model?: string }): Promise<number[][]>;
}

export interface LlmCapabilityConfig extends LlmProviderMetadata {
  apiKey: string;
  baseUrl?: string;
}

export interface ResolvedLlmConfig {
  chat: LlmCapabilityConfig;
  rewrite: LlmCapabilityConfig;
  rerank: LlmCapabilityConfig;
  embeddings: LlmCapabilityConfig;
  embeddingProviderConfigs: LlmCapabilityConfig[];
}

export class ProviderConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderConfigurationError";
  }
}
