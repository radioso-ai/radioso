import type {
  EmbeddingProviderImplementation,
  EmbeddingPurpose,
} from "../../../modules/embeddingProfiles/contracts/embeddingProvider.js";

export type { EmbeddingPurpose } from "../../../modules/embeddingProfiles/contracts/embeddingProvider.js";

export type LlmProviderName = "openai" | "openai-compatible" | "gemini" | "claude";
export type LlmCapabilityName = "chat" | "rewrite" | "rerank" | "embeddings";

export interface LlmProviderMetadata {
  capability: LlmCapabilityName;
  provider: LlmProviderName;
  model: string;
  /** Adapter-local cache support, exposed only as a bounded telemetry label. */
  cacheCapability?: ProviderCacheCapability;
}

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high";

export interface JsonSchemaResponseFormat {
  type: "json_schema";
  name: string;
  strict: boolean;
  schema: Record<string, unknown>;
}

/**
 * A provider sets this once it has handed a request to its transport. Callers read
 * it after the call to decide whether the attempt is billable. It is deliberately
 * data rather than a callback: no caller code runs inside a provider.
 */
export interface ProviderDispatchRecord {
  dispatched: boolean;
}

/**
 * A single, exact breakpoint in the system message. The prefix is eligible for
 * provider reuse; the suffix remains request-specific. Product code owns where
 * the breakpoint sits and providers only render it.
 */
export interface ReusableInputBoundary {
  stableSystemPrefix: string;
  dynamicSystemSuffix: string;
}

export type ProviderCacheCapability = "unsupported" | "implicit" | "explicit_checkpoint";

/** Provider evidence only: omitted values are unknown, never inferred as zero. */
export interface CacheAccounting {
  state: "reported" | "unknown";
  readInputTokens?: number;
  writeInputTokens?: number;
}

export interface TextGenerationRequest {
  prompt: string;
  systemPrompt?: string;
  reusableInputBoundary?: ReusableInputBoundary;
  temperature?: number;
  maxOutputTokens?: number;
  // Provider-neutral hint for reasoning models. Currently honored only by the
  // OpenAI provider (gpt-5 family); other providers ignore it. When set, the
  // OpenAI provider forwards reasoning_effort and omits the (unsupported)
  // temperature so reasoning models don't spend the whole output budget on
  // hidden reasoning and return empty visible text.
  reasoningEffort?: ReasoningEffort;
  /** Provider-enforced final response shape. Official providers map this to
   * strict JSON-schema output (or an equivalent forced schema tool). */
  responseFormat?: JsonSchemaResponseFormat;
  signal?: AbortSignal;
  dispatchRecord?: ProviderDispatchRecord;
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
  cacheAccounting?: CacheAccounting;
  reasoningTokens?: number;
  providerRequestId?: string;
  quality: UsageQuality;
}

/**
 * Why the provider stopped generating, normalized across SDKs. `output_limit`
 * means the reply was cut off at `maxOutputTokens`; `completed` means the model
 * finished on its own (a forced schema tool call included); `other` covers any
 * other reason the provider gives, such as a content filter.
 */
export type TextGenerationStopReason = "completed" | "output_limit" | "other";

export interface TextGenerationResult {
  text: string;
  usage?: ProviderUsage;
  /** Omitted when the provider gives no reason; never inferred. */
  stopReason?: TextGenerationStopReason;
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

export interface EmbeddingClientOptions {
  model?: string;
  dimensions?: number;
  purpose?: EmbeddingPurpose;
  provider?: EmbeddingProviderImplementation;
  endpointScopeFingerprint?: string;
  /** Internal routing context used to resolve workspace-scoped credentials lazily. */
  workspaceId?: string;
}

export interface TextGenerationClient {
  readonly metadata: LlmProviderMetadata;
  complete(input: TextGenerationRequest): Promise<TextGenerationResult>;
  stream(input: TextGenerationRequest): TextGenerationStreamResult;
}

export interface EmbeddingClient {
  readonly metadata: LlmProviderMetadata;
  embedTexts(texts: string[], options?: EmbeddingClientOptions): Promise<EmbeddingResult>;
}

/**
 * Which step of the resolution path chose the provider and model. Surfaced in
 * settings and logs so "why is it not using the model I picked" has an answer.
 */
export type LlmCapabilityResolvedBy =
  | "managed_plan"
  | "agent_override"
  | "workspace_preference"
  | "environment_default";

/** Provider and model as resolved for a workspace, before any key is attached. */
export interface LlmCapabilitySelection {
  provider: LlmProviderName;
  model: string;
  resolvedBy: LlmCapabilityResolvedBy;
}

/**
 * The only data-residency values a native `openai` call ever carries: `global` (OpenAI's
 * default endpoint), or an explicit US or EU data-residency endpoint. Describes either a
 * platform-held key's resolved `OPENAI_DATA_RESIDENCY` setting or a workspace's own (BYOK)
 * credential's authored residency — the two are independent choices that happen to share one
 * allowed-value list and one host mapping. The single source for this list — `env.ts`'s zod
 * enum reads it too, so an allowed value can never drift between the two.
 */
export const OPENAI_DATA_RESIDENCIES = ["global", "us", "eu"] as const;
export type OpenAIDataResidency = (typeof OPENAI_DATA_RESIDENCIES)[number];

/**
 * The host each residency reaches, including `global`. This is the one place that maps a
 * residency to a concrete OpenAI host; the client factory (`openaiProvider.ts`) uses it to
 * build every native `openai` request's base URL, and `providerConfig.ts` uses it for the
 * non-default residencies it stamps onto a resolved capability.
 */
export const OPENAI_RESIDENCY_HOSTS: Record<OpenAIDataResidency, string> = {
  global: "https://api.openai.com/v1",
  us: "https://us.api.openai.com/v1",
  eu: "https://eu.api.openai.com/v1",
};

export interface LlmCapabilityConfig extends LlmProviderMetadata {
  apiKey: string;
  baseUrl?: string;
  /**
   * Set only for `provider: "openai"`, and only when the key answering this call — platform or
   * workspace (BYOK) — resolved to a non-default residency. The client factory treats an unset
   * value as `global`.
   */
  openAIDataResidency?: OpenAIDataResidency;
  resolvedBy?: LlmCapabilityResolvedBy;
}

/** Boot-safe provider/model defaults. Credentials are attached only when a call starts. */
export interface LlmCapabilityDefault extends LlmProviderMetadata {
  baseUrl?: string;
  /** See {@link LlmCapabilityConfig.openAIDataResidency}. */
  openAIDataResidency?: OpenAIDataResidency;
}

export interface ResolvedLlmConfig {
  chat: LlmCapabilityDefault;
  rewrite: LlmCapabilityDefault;
  rerank: LlmCapabilityDefault;
  embeddings: LlmCapabilityDefault;
  embeddingProviderConfigs: LlmCapabilityDefault[];
  providerApiKeys?: Partial<Record<LlmProviderName, string>>;
  /**
   * The platform-held `OPENAI_API_KEY`'s resolved data residency, derived once here from
   * `OPENAI_DATA_RESIDENCY`. Present only when a platform OpenAI key is configured — a
   * deployment running entirely on workspace (BYOK) OpenAI keys has no platform residency to
   * report or route by. Composition and the startup log read this instead of re-deriving it.
   */
  openAIPlatformResidency?: {
    residency: OpenAIDataResidency;
    baseUrl?: string;
  };
}

import { AppError } from "../../domain/errors.js";
import type { VoiceVendor } from "../../domain/voiceVendor.js";

type ProviderMisconfigurationKind =
  | "missing_api_key"
  | "missing_base_url"
  | "unsupported_provider"
  | "embeddings_not_supported"
  | "credential_unreadable"
  | "missing_required_setting";

interface ProviderMisconfigurationDetails {
  providerIssue: "configuration_invalid";
  kind: ProviderMisconfigurationKind;
  /** A voice vendor only for `credential_unreadable`: the workspace credential store holds both kinds of key. */
  provider?: LlmProviderName | VoiceVendor;
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
