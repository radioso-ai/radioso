import {
  type LlmCapabilityConfig,
  type TextGenerationClient,
} from "./providerTypes.js";
import { LLM_DEFAULTS } from "../../domain/behaviorConfig.js";
import { parseSseEvents } from "./sse.js";

const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages";
const CLAUDE_VERSION = "2023-06-01";

const buildClaudeBody = (config: LlmCapabilityConfig, input: {
  prompt: string;
  systemPrompt?: string;
  temperature?: number;
  maxOutputTokens?: number;
  stream?: boolean;
}) => ({
  model: config.model,
  max_tokens: input.maxOutputTokens ?? LLM_DEFAULTS.textGenerationMaxOutputTokens,
  temperature: input.temperature,
  system: input.systemPrompt,
  stream: input.stream ?? false,
  messages: [
    {
      role: "user",
      content: input.prompt,
    },
  ],
});

const extractClaudeText = (payload: unknown): string => {
  const content = (payload as { content?: Array<{ type?: string; text?: string }> })?.content ?? [];
  return content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
};

export class ClaudeTextGenerationClient implements TextGenerationClient {
  readonly metadata;

  constructor(private readonly config: LlmCapabilityConfig) {
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
    const response = await fetch(CLAUDE_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.config.apiKey,
        "anthropic-version": CLAUDE_VERSION,
      },
      body: JSON.stringify(buildClaudeBody(this.config, input)),
    });

    if (!response.ok) {
      throw new Error(`Claude request failed: ${response.status}`);
    }

    const payload = await response.json();
    return extractClaudeText(payload);
  }

  async *stream(input: {
    prompt: string;
    systemPrompt?: string;
    temperature?: number;
    maxOutputTokens?: number;
  }): AsyncIterable<string> {
    const response = await fetch(CLAUDE_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.config.apiKey,
        "anthropic-version": CLAUDE_VERSION,
      },
      body: JSON.stringify(buildClaudeBody(this.config, { ...input, stream: true })),
    });

    if (!response.ok || !response.body) {
      throw new Error(`Claude stream failed: ${response.status}`);
    }

    for await (const data of parseSseEvents(response.body)) {
      if (data === "[DONE]") {
        continue;
      }

      const payload = JSON.parse(data) as {
        type?: string;
        delta?: { type?: string; text?: string };
      };
      if (payload.type === "content_block_delta" && payload.delta?.type === "text_delta" && payload.delta.text) {
        yield payload.delta.text;
      }
    }
  }
}
