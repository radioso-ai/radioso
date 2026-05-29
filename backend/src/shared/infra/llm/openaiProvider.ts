import OpenAI from "openai";

import {
  type EmbeddingClient,
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
): ChatSamplingParams => {
  const tokenLimit = buildTokenLimit(provider, input.maxOutputTokens);
  if (provider === "openai" && input.reasoningEffort) {
    return { ...tokenLimit, reasoning_effort: input.reasoningEffort };
  }
  return { ...tokenLimit, temperature: input.temperature };
};

const buildStreamUsageOptions = (
  provider: LlmCapabilityConfig["provider"],
): { stream_options?: { include_usage: true } } =>
  provider === "openai"
    ? { stream_options: { include_usage: true } }
    : {};

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
    const response = await this.client.chat.completions.create({
      model: this.config.model,
      ...buildChatSamplingParams(this.config.provider, input),
      messages: buildMessages(input),
    });

    return {
      text: response.choices[0]?.message?.content ?? "",
      usage: toProviderUsage(response.usage, response.id),
    };
  }

  stream(input: TextGenerationRequest): TextGenerationStreamResult {
    const client = this.client;
    const config = this.config;
    return streamWithUsage(async function* () {
      const stream = await client.chat.completions.create({
        model: config.model,
        stream: true,
        // Ask OpenAI to append a final usage-only chunk after the content chunks.
        ...buildStreamUsageOptions(config.provider),
        ...buildChatSamplingParams(config.provider, input),
        messages: buildMessages(input),
      });

      let usage: ProviderUsage | undefined;
      let requestId: string | undefined;
      for await (const chunk of stream) {
        requestId ??= chunk.id;
        const text = chunk.choices[0]?.delta?.content ?? "";
        if (text) {
          yield text;
        }
        if (chunk.usage) {
          usage = toProviderUsage(chunk.usage, requestId);
        }
      }
      return usage;
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

  async embedTexts(texts: string[], options?: { model?: string }): Promise<EmbeddingResult> {
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
