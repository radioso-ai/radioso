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

import { AppError } from "../../domain/errors.js";

export type ProviderMisconfigurationKind =
  | "missing_api_key"
  | "missing_base_url"
  | "unsupported_provider"
  | "embeddings_not_supported"
  | "credential_unreadable"
  | "missing_required_setting";

export interface ProviderMisconfigurationDetails {
  providerIssue: "configuration_invalid";
  kind: ProviderMisconfigurationKind;
  provider?: LlmProviderName;
  capability?: LlmCapabilityName;
  setting?: string;
  remediation?: string;
}

/**
 * Raised when the LLM provider stack cannot serve a request because the resolved
 * provider/model/key/base-URL combination is incomplete. Subclasses AppError so
 * the HTTP error handler returns a structured 503 with an actionable code; at
 * boot time the process still crashes because the runtime catches and rethrows.
 */
export class ProviderConfigurationError extends AppError {
  constructor(message: string, details?: Partial<ProviderMisconfigurationDetails>) {
    super(503, "provider_misconfigured", message, {
      providerIssue: "configuration_invalid",
      kind: details?.kind ?? "missing_required_setting",
      ...(details?.provider ? { provider: details.provider } : {}),
      ...(details?.capability ? { capability: details.capability } : {}),
      ...(details?.setting ? { setting: details.setting } : {}),
      ...(details?.remediation ? { remediation: details.remediation } : {}),
    });
    this.name = "ProviderConfigurationError";
  }
}
