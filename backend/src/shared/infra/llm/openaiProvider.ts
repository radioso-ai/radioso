import OpenAI from "openai";

import {
  type EmbeddingClient,
  type LlmCapabilityConfig,
  type LlmProviderName,
  type ReasoningEffort,
  type TextGenerationClient,
  type TextGenerationRequest,
} from "./providerTypes.js";
import { EMBEDDING_REQUEST_TIMEOUT_MS, runProviderRequestWithTimeout } from "./providerTimeouts.js";
import type { AppLogger } from "../../observability/logger.js";

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

  async complete(input: TextGenerationRequest): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: this.config.model,
      ...buildChatSamplingParams(this.config.provider, input),
      messages: buildMessages(input),
    });

    return response.choices[0]?.message?.content ?? "";
  }

  async *stream(input: TextGenerationRequest): AsyncIterable<string> {
    const stream = await this.client.chat.completions.create({
      model: this.config.model,
      stream: true,
      ...buildChatSamplingParams(this.config.provider, input),
      messages: buildMessages(input),
    });

    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content ?? "";
      if (text) {
        yield text;
      }
    }
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

  async embedTexts(texts: string[], options?: { model?: string }): Promise<number[][]> {
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

      return response.data.map((item) => item.embedding);
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
