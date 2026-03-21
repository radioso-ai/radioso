import OpenAI from "openai";

import {
  type EmbeddingClient,
  type LlmCapabilityConfig,
  type TextGenerationClient,
} from "./providerTypes.js";

const buildMessages = (input: { systemPrompt?: string; prompt: string }) => {
  const messages: Array<{ role: "system" | "user"; content: string }> = [];
  if (input.systemPrompt) {
    messages.push({ role: "system", content: input.systemPrompt });
  }
  messages.push({ role: "user", content: input.prompt });
  return messages;
};

const createClient = (config: LlmCapabilityConfig): OpenAI =>
  new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
  });

export class OpenAITextGenerationClient implements TextGenerationClient {
  readonly metadata;
  private readonly client: OpenAI;

  constructor(private readonly config: LlmCapabilityConfig) {
    this.client = createClient(config);
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
      max_tokens: input.maxOutputTokens,
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
      max_tokens: input.maxOutputTokens,
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

  constructor(private readonly config: LlmCapabilityConfig) {
    this.client = createClient(config);
    this.metadata = {
      capability: config.capability,
      provider: config.provider,
      model: config.model,
    };
  }

  async embedTexts(texts: string[]): Promise<number[][]> {
    const response = await this.client.embeddings.create({
      model: this.config.model,
      input: texts,
    });

    return response.data.map((item) => item.embedding);
  }
}
