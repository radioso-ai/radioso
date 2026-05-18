import OpenAI from "openai";

import {
  type EmbeddingClient,
  type LlmCapabilityConfig,
  type TextGenerationClient,
} from "./providerTypes.js";
import type { AppLogger } from "../../observability/logger.js";

const STORAGE_VECTOR_DIMENSIONS = 1536;

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

  async complete(input: {
    prompt: string;
    systemPrompt?: string;
    temperature?: number;
    maxOutputTokens?: number;
  }): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: this.config.model,
      temperature: input.temperature,
      ...buildTokenLimit(this.config.provider, input.maxOutputTokens),
      messages: buildMessages(input),
    });

    return response.choices[0]?.message?.content ?? "";
  }

  async *stream(input: {
    prompt: string;
    systemPrompt?: string;
    temperature?: number;
    maxOutputTokens?: number;
  }): AsyncIterable<string> {
    const stream = await this.client.chat.completions.create({
      model: this.config.model,
      stream: true,
      temperature: input.temperature,
      ...buildTokenLimit(this.config.provider, input.maxOutputTokens),
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
    const dimensions = this.config.provider === "openai" && model.startsWith("text-embedding-3-")
      ? STORAGE_VECTOR_DIMENSIONS
      : undefined;
    try {
      const response = await this.client.embeddings.create({
        model,
        input: texts,
        ...(dimensions ? { dimensions } : {}),
      });
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
