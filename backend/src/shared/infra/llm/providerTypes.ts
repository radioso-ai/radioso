export type LlmProviderName = "openai" | "openai-compatible" | "gemini" | "claude";
export type LlmCapabilityName = "chat" | "rewrite" | "rerank" | "embeddings";

export interface LlmProviderMetadata {
  capability: LlmCapabilityName;
  provider: LlmProviderName;
  model: string;
}

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high";

export interface TextGenerationRequest {
  prompt: string;
  systemPrompt?: string;
  temperature?: number;
  maxOutputTokens?: number;
  // Provider-neutral hint for reasoning models. Currently honored only by the
  // OpenAI provider (gpt-5 family); other providers ignore it. When set, the
  // OpenAI provider forwards reasoning_effort and omits the (unsupported)
  // temperature so reasoning models don't spend the whole output budget on
  // hidden reasoning and return empty visible text.
  reasoningEffort?: ReasoningEffort;
  signal?: AbortSignal;
}

export type UsageQuality = "actual" | "estimated";

/**
 * Provider-reported resource usage for a single call, normalized across SDKs.
 * Carries raw counts only — no monetary cost and no pricing. `quality` is
 * `"actual"` when these counts came from the provider; the recording layer
 * (a later delivery phase) owns producing `"estimated"` usage when a provider
 * returns none. Absent provider usage is represented by omitting the usage
 * object entirely, not by an estimated stub here.
 */
export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  providerRequestId?: string;
  quality: UsageQuality;
}

export interface TextGenerationResult {
  text: string;
  usage?: ProviderUsage;
}

/**
 * Streaming result. `textStream` keeps the homogeneous text-chunk semantics of
 * the previous contract; `usage` resolves once the stream completes (or errors)
 * with the provider's final usage when available, otherwise `undefined`. The
 * `usage` promise never rejects: a mid-stream failure surfaces through
 * `textStream` so it cannot be masked by the usage channel. `usage` only
 * settles after `textStream` has been consumed to completion.
 */
export interface TextGenerationStreamResult {
  textStream: AsyncIterable<string>;
  usage: Promise<ProviderUsage | undefined>;
}

export interface EmbeddingResult {
  vectors: number[][];
  usage?: ProviderUsage;
}

export interface TextGenerationClient {
  readonly metadata: LlmProviderMetadata;
  complete(input: TextGenerationRequest): Promise<TextGenerationResult>;
  stream(input: TextGenerationRequest): TextGenerationStreamResult;
}

export interface EmbeddingClient {
  readonly metadata: LlmProviderMetadata;
  embedTexts(texts: string[], options?: { model?: string }): Promise<EmbeddingResult>;
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
