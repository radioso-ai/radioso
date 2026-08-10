import { createHash } from "node:crypto";

import OpenAI from "openai";

import {
  type EmbeddingClient,
  type EmbeddingClientOptions,
  type EmbeddingResult,
  type LlmCapabilityConfig,
  type LlmProviderName,
  type ProviderUsage,
  type ReasoningEffort,
  type TextGenerationClient,
  type TextGenerationRequest,
  type TextGenerationResult,
  type TextGenerationStreamResult,
} from "./providerTypes.js";
import { streamWithUsage } from "./providerStreaming.js";
import { EMBEDDING_REQUEST_TIMEOUT_MS, runProviderRequestWithTimeout } from "./providerTimeouts.js";
import { normalizeOpenAIReasoningEffort } from "./knownModels.js";
import {
  isReasoningEffortKnownUnsupported,
  isTemperatureKnownUnsupported,
  isUnsupportedReasoningEffortError,
  isUnsupportedTemperatureError,
  markReasoningEffortUnsupported,
  markTemperatureUnsupported,
} from "./samplingParamSupport.js";
import type { AppLogger } from "../../observability/logger.js";

interface OpenAIUsagePayload {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
  completion_tokens_details?: { reasoning_tokens?: number } | null;
}

const toProviderUsage = (
  usage: OpenAIUsagePayload | null | undefined,
  requestId: string | undefined,
): ProviderUsage | undefined => {
  if (!usage) {
    return undefined;
  }
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    cachedInputTokens: usage.prompt_tokens_details?.cached_tokens ?? undefined,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? undefined,
    providerRequestId: requestId,
    quality: "actual",
  };
};

const sumOptionalUsage = (
  left: number | undefined,
  right: number | undefined,
): number | undefined =>
  left === undefined && right === undefined
    ? undefined
    : (left ?? 0) + (right ?? 0);

const aggregateProviderUsage = (
  first: ProviderUsage | undefined,
  second: ProviderUsage | undefined,
): ProviderUsage | undefined => {
  if (!first) {
    return second;
  }
  if (!second) {
    return first;
  }
  return {
    inputTokens: sumOptionalUsage(first.inputTokens, second.inputTokens),
    outputTokens: sumOptionalUsage(first.outputTokens, second.outputTokens),
    totalTokens: sumOptionalUsage(first.totalTokens, second.totalTokens),
    cachedInputTokens: sumOptionalUsage(first.cachedInputTokens, second.cachedInputTokens),
    reasoningTokens: sumOptionalUsage(first.reasoningTokens, second.reasoningTokens),
    providerRequestId: second.providerRequestId ?? first.providerRequestId,
    quality: first.quality === "actual" && second.quality === "actual" ? "actual" : "estimated",
  };
};

const buildMessages = (input: { systemPrompt?: string; prompt: string }) => {
  const messages: Array<{ role: "system" | "user"; content: string }> = [];
  if (input.systemPrompt) {
    messages.push({ role: "system", content: input.systemPrompt });
  }
  messages.push({ role: "user", content: input.prompt });
  return messages;
};

const buildTokenLimit = (
  provider: LlmCapabilityConfig["provider"],
  maxOutputTokens?: number,
): { max_completion_tokens?: number; max_tokens?: number } =>
  provider === "openai-compatible"
    ? { max_tokens: maxOutputTokens }
    : { max_completion_tokens: maxOutputTokens };

export interface ChatSamplingParams {
  temperature?: number;
  max_completion_tokens?: number;
  max_tokens?: number;
  reasoning_effort?: ReasoningEffort;
}

interface OpenAIChatCompletionChoice {
  finish_reason?: string | null;
  message?: { content?: string | null } | null;
}

interface OpenAIChatCompletionResponse {
  choices: OpenAIChatCompletionChoice[];
  usage?: OpenAIUsagePayload | null;
  id?: string;
}

interface OpenAIChatCompletionChunk {
  id?: string;
  choices?: Array<{
    delta?: { content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: OpenAIUsagePayload | null;
}

interface OpenAIStreamReadResult {
  usage?: ProviderUsage;
  sawText: boolean;
  finishReason?: string | null;
}

// The installed OpenAI SDK types (v5) predate "none" as a reasoning_effort value,
// though the API accepts it. Produce spread-ready sampling with reasoning_effort
// coerced to the SDK's param type — and omitted entirely when unset. The shared
// fallback handles any model that rejects its normalized value at runtime.
type OpenAIChatReasoningEffort = OpenAI.Chat.Completions.ChatCompletionCreateParams["reasoning_effort"];
const toSdkSampling = ({ reasoning_effort, ...rest }: ChatSamplingParams) =>
  reasoning_effort === undefined
    ? rest
    : { ...rest, reasoning_effort: reasoning_effort as OpenAIChatReasoningEffort };

/**
 * Shapes the sampling/limit params for a chat.completions call. For the first-party
 * OpenAI provider (gpt-5 family reasoning models), a requested reasoning effort is
 * forwarded as reasoning_effort and temperature is dropped — those models reject a
 * non-default temperature and otherwise consume the whole token budget on hidden
 * reasoning, returning empty visible text. openai-compatible endpoints serve
 * arbitrary models, so we never assume reasoning support there.
 */
export const buildChatSamplingParams = (
  provider: LlmProviderName,
  input: { temperature?: number; maxOutputTokens?: number; reasoningEffort?: ReasoningEffort },
  model?: string,
): ChatSamplingParams => {
  const tokenLimit = buildTokenLimit(provider, input.maxOutputTokens);
  if (provider === "openai" && input.reasoningEffort) {
    return {
      ...tokenLimit,
      reasoning_effort: model
        ? normalizeOpenAIReasoningEffort(model, input.reasoningEffort)
        : input.reasoningEffort,
    };
  }
  return { ...tokenLimit, temperature: input.temperature };
};

const buildStreamUsageOptions = (
  provider: LlmCapabilityConfig["provider"],
): { stream_options?: { include_usage: true } } =>
  provider === "openai"
    ? { stream_options: { include_usage: true } }
    : {};

const buildResponseFormat = (
  provider: LlmCapabilityConfig["provider"],
  input: TextGenerationRequest,
) => {
  if (provider !== "openai" || !input.responseFormat) {
    return {};
  }
  const { type, ...jsonSchema } = input.responseFormat;
  return {
    response_format: {
      type,
      json_schema: jsonSchema,
    },
  };
};

const withoutReasoningEffort = ({ reasoning_effort: _omit, ...rest }: ChatSamplingParams): ChatSamplingParams => rest;

const withoutTemperature = ({ temperature: _omit, ...rest }: ChatSamplingParams): ChatSamplingParams => rest;

const hashSamplingApiKey = (apiKey: string): string =>
  createHash("sha256").update(apiKey).digest("hex").slice(0, 16);

const samplingSupportCacheKey = (config: LlmCapabilityConfig): string =>
  `${config.provider}:${config.model}:${hashSamplingApiKey(config.apiKey)}:${config.baseUrl ?? ""}`;

/**
 * One sampling param the API may reject, described by how to spot the rejection,
 * remember it for the support scope, and drop it. Every entry must be safe to strip:
 * reasoning effort is only a latency hint, and a model that rejects a temperature
 * accepts nothing but its own default, so sending no temperature is the only
 * behavior that can succeed at all.
 */
interface StrippableSamplingParam {
  readonly isPresent: (sampling: ChatSamplingParams) => boolean;
  readonly isKnownUnsupported: (supportScope: string, sampling: ChatSamplingParams) => boolean;
  readonly remember: (supportScope: string, sampling: ChatSamplingParams) => void;
  readonly wasRejected: (error: unknown) => boolean;
  readonly strip: (sampling: ChatSamplingParams) => ChatSamplingParams;
}

const STRIPPABLE_SAMPLING_PARAMS: readonly StrippableSamplingParam[] = [
  {
    isPresent: (sampling) => sampling.reasoning_effort !== undefined,
    isKnownUnsupported: (supportScope, sampling) =>
      sampling.reasoning_effort !== undefined
      && isReasoningEffortKnownUnsupported(supportScope, sampling.reasoning_effort),
    remember: (supportScope, sampling) => {
      if (sampling.reasoning_effort !== undefined) {
        markReasoningEffortUnsupported(supportScope, sampling.reasoning_effort);
      }
    },
    wasRejected: isUnsupportedReasoningEffortError,
    strip: withoutReasoningEffort,
  },
  // Dropping a temperature is deliberately not surfaced to operators. Temperature
  // is not configurable: it has no settings UI, API field, or SDK surface, and is
  // only ever set by internal call sites. So a silent strip cannot contradict a
  // value anyone chose, and reporting it would be noise about an internal default.
  // Revisit if temperature ever becomes operator-settable.
  {
    isPresent: (sampling) => sampling.temperature !== undefined,
    isKnownUnsupported: (supportScope) => isTemperatureKnownUnsupported(supportScope),
    remember: (supportScope) => markTemperatureUnsupported(supportScope),
    wasRejected: isUnsupportedTemperatureError,
    strip: withoutTemperature,
  },
];

const withLowReasoningEffort = (model: string, sampling: ChatSamplingParams): ChatSamplingParams => ({
  ...sampling,
  reasoning_effort: normalizeOpenAIReasoningEffort(model, "low"),
});

const lowReasoningRetrySampling = (
  model: string,
  sampling: ChatSamplingParams,
): ChatSamplingParams | null => {
  if (sampling.reasoning_effort === undefined || sampling.reasoning_effort === "low") {
    return null;
  }
  return withLowReasoningEffort(model, sampling);
};

const completionText = (response: OpenAIChatCompletionResponse): string =>
  response.choices[0]?.message?.content ?? "";

const isCapExhaustedEmptyCompletion = (response: OpenAIChatCompletionResponse): boolean =>
  response.choices[0]?.finish_reason === "length" && !completionText(response).trim();

const readCompletionStream = async function* (
  stream: AsyncIterable<OpenAIChatCompletionChunk>,
): AsyncGenerator<string, OpenAIStreamReadResult, void> {
  let usage: ProviderUsage | undefined;
  let requestId: string | undefined;
  let finishReason: string | null | undefined;
  let sawText = false;
  for await (const chunk of stream) {
    requestId ??= chunk.id;
    const choice = chunk.choices?.[0];
    finishReason = choice?.finish_reason ?? finishReason;
    const text = choice?.delta?.content ?? "";
    if (text) {
      sawText = true;
      yield text;
    }
    if (chunk.usage) {
      usage = toProviderUsage(chunk.usage, requestId);
    }
  }
  return { usage, sawText, finishReason };
};

/**
 * Runs a chat.completions create, reconciling the requested sampling params with
 * what the configured endpoint actually accepts. Any param already known-rejected
 * for this endpoint/model/key scope is dropped before the first attempt, so the
 * wasted round-trip is paid at most once per scope; a rejection seen at runtime is
 * remembered and the call retried without that param.
 *
 * Support is learned from the API's own response rather than inferred from the
 * model id, and the support scope includes `openai-compatible` endpoint identity
 * so one backend cannot suppress params for another backend using the same model
 * string.
 *
 * A single request can be rejected for more than one param, so the retry budget is
 * one attempt per strippable param — bounded by that count, never a loop that runs
 * while the API keeps complaining. Anything not attributable to a param we sent is
 * rethrown untouched.
 */
export const createChatCompletionWithSamplingFallback = async <T>(
  supportCacheKey: string,
  sampling: ChatSamplingParams,
  create: (sampling: ChatSamplingParams) => Promise<T>,
): Promise<T> => {
  let attempted = STRIPPABLE_SAMPLING_PARAMS.reduce(
    (current, param) => (param.isKnownUnsupported(supportCacheKey, current) ? param.strip(current) : current),
    sampling,
  );
  for (let retriesLeft = STRIPPABLE_SAMPLING_PARAMS.length; retriesLeft > 0; retriesLeft -= 1) {
    try {
      return await create(attempted);
    } catch (error) {
      const rejected = STRIPPABLE_SAMPLING_PARAMS.find(
        (param) => param.isPresent(attempted) && param.wasRejected(error),
      );
      if (!rejected) {
        throw error;
      }
      rejected.remember(supportCacheKey, attempted);
      attempted = rejected.strip(attempted);
    }
  }
  return create(attempted);
};

export const createOpenAIClient = (config: LlmCapabilityConfig): OpenAI =>
  new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
  });

export class OpenAITextGenerationClient implements TextGenerationClient {
  readonly metadata;
  private readonly client: OpenAI;

  constructor(private readonly config: LlmCapabilityConfig) {
    this.client = createOpenAIClient(config);
    this.metadata = {
      capability: config.capability,
      provider: config.provider,
      model: config.model,
    };
  }

  async complete(input: TextGenerationRequest): Promise<TextGenerationResult> {
    const messages = buildMessages(input);
    const sampling = buildChatSamplingParams(this.config.provider, input, this.config.model);
    const createCompletion = (samplingParams: ChatSamplingParams) => {
      const request = {
        model: this.config.model,
        ...toSdkSampling(samplingParams),
        ...buildResponseFormat(this.config.provider, input),
        messages,
      };
      return (input.signal
        ? this.client.chat.completions.create(request, { signal: input.signal })
        : this.client.chat.completions.create(request)) as Promise<OpenAIChatCompletionResponse>;
    };
    let response = await createChatCompletionWithSamplingFallback(
      samplingSupportCacheKey(this.config),
      sampling,
      createCompletion,
    );
    let usage = toProviderUsage(response.usage, response.id);
    const retrySampling = isCapExhaustedEmptyCompletion(response)
      ? lowReasoningRetrySampling(this.config.model, sampling)
      : null;
    if (retrySampling) {
      response = await createChatCompletionWithSamplingFallback(
        samplingSupportCacheKey(this.config),
        retrySampling,
        createCompletion,
      );
      usage = aggregateProviderUsage(usage, toProviderUsage(response.usage, response.id));
    }

    return {
      text: completionText(response),
      usage,
    };
  }

  stream(input: TextGenerationRequest): TextGenerationStreamResult {
    const client = this.client;
    const config = this.config;
    const messages = buildMessages(input);
    const sampling = buildChatSamplingParams(config.provider, input, config.model);
    const createStream = (samplingParams: ChatSamplingParams) => {
      const request = {
        model: config.model,
        stream: true as const,
        // Ask OpenAI to append a final usage-only chunk after the content chunks.
        ...buildStreamUsageOptions(config.provider),
        ...toSdkSampling(samplingParams),
        ...buildResponseFormat(config.provider, input),
        messages,
      };
      return (input.signal
        ? client.chat.completions.create(request, { signal: input.signal })
        : client.chat.completions.create(request)) as Promise<AsyncIterable<OpenAIChatCompletionChunk>>;
    };
    return streamWithUsage(async function* () {
      const stream = await createChatCompletionWithSamplingFallback(
        samplingSupportCacheKey(config),
        sampling,
        createStream,
      );
      let result = yield* readCompletionStream(stream);
      const retrySampling =
        !result.sawText && result.finishReason === "length"
          ? lowReasoningRetrySampling(config.model, sampling)
          : null;
      if (retrySampling) {
        const firstUsage = result.usage;
        const retryStream = await createChatCompletionWithSamplingFallback(
          samplingSupportCacheKey(config),
          retrySampling,
          createStream,
        );
        result = yield* readCompletionStream(retryStream);
        result = {
          ...result,
          usage: aggregateProviderUsage(firstUsage, result.usage),
        };
      }
      return result.usage;
    });
  }
}

export class OpenAIEmbeddingClient implements EmbeddingClient {
  readonly metadata;
  private readonly client: OpenAI;

  constructor(
    private readonly config: LlmCapabilityConfig,
    private readonly logger?: AppLogger,
  ) {
    this.client = createOpenAIClient(config);
    this.metadata = {
      capability: config.capability,
      provider: config.provider,
      model: config.model,
    };
  }

  async embedTexts(texts: string[], options?: EmbeddingClientOptions): Promise<EmbeddingResult> {
    const startedAt = Date.now();
    const model = options?.model ?? this.config.model;
    try {
      const response = await runProviderRequestWithTimeout(
        "OpenAI embeddings request",
        EMBEDDING_REQUEST_TIMEOUT_MS,
        (signal) =>
          this.client.embeddings.create(
            {
              model,
              input: texts,
              ...(this.config.provider === "openai" &&
              model.startsWith("text-embedding-3-") &&
              options?.dimensions !== undefined
                ? { dimensions: options.dimensions }
                : {}),
            },
            { signal },
          ),
      );
      const durationMs = Math.max(0, Date.now() - startedAt);
      this.logger?.info(
        {
          llmCapability: this.metadata.capability,
          llmProvider: this.metadata.provider,
          llmModel: model,
          embeddingInputCount: texts.length,
          embeddingCharacterCount: texts.reduce((sum, text) => sum + text.length, 0),
          embeddingDurationMs: durationMs,
        },
        "OpenAI embeddings request completed",
      );

      return {
        vectors: response.data.map((item) => item.embedding),
        usage: toProviderUsage(response.usage, undefined),
      };
    } catch (error) {
      const durationMs = Math.max(0, Date.now() - startedAt);
      const apiError = error as { status?: number; code?: string; type?: string };
      this.logger?.error(
        {
          error,
          llmCapability: this.metadata.capability,
          llmProvider: this.metadata.provider,
          llmModel: model,
          embeddingInputCount: texts.length,
          embeddingCharacterCount: texts.reduce((sum, text) => sum + text.length, 0),
          embeddingDurationMs: durationMs,
          statusCode: apiError?.status,
          providerErrorCode: apiError?.code,
          providerErrorType: apiError?.type,
        },
        "OpenAI embeddings request failed",
      );
      throw error;
    }
  }
}
