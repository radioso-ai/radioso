import {
  type LlmCapabilityConfig,
  type ProviderUsage,
  type TextGenerationClient,
  type TextGenerationResult,
  type TextGenerationStreamResult,
} from "./providerTypes.js";
import { readProviderErrorBody } from "./providerErrors.js";
import { streamWithUsage } from "./providerStreaming.js";
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

interface ClaudeUsagePayload {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
}

const buildClaudeUsage = (input: {
  usage: ClaudeUsagePayload | undefined;
  requestId: string | undefined;
}): ProviderUsage | undefined => {
  const usage = input.usage;
  if (!usage || (usage.input_tokens === undefined && usage.output_tokens === undefined)) {
    return undefined;
  }
  const inputTokens = usage.input_tokens;
  const outputTokens = usage.output_tokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens:
      inputTokens === undefined && outputTokens === undefined
        ? undefined
        : (inputTokens ?? 0) + (outputTokens ?? 0),
    cachedInputTokens: usage.cache_read_input_tokens,
    providerRequestId: input.requestId,
    quality: "actual",
  };
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
  }): Promise<TextGenerationResult> {
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
      throw await readProviderErrorBody("Claude", "messages", response);
    }

    const payload = (await response.json()) as {
      id?: string;
      usage?: ClaudeUsagePayload;
    };
    return {
      text: extractClaudeText(payload),
      usage: buildClaudeUsage({ usage: payload.usage, requestId: payload.id }),
    };
  }

  stream(input: {
    prompt: string;
    systemPrompt?: string;
    temperature?: number;
    maxOutputTokens?: number;
  }): TextGenerationStreamResult {
    const config = this.config;
    return streamWithUsage(async function* () {
      const response = await fetch(CLAUDE_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": config.apiKey,
          "anthropic-version": CLAUDE_VERSION,
        },
        body: JSON.stringify(buildClaudeBody(config, { ...input, stream: true })),
      });

      if (!response.ok) {
        throw await readProviderErrorBody("Claude", "messages.stream", response);
      }
      if (!response.body) {
        throw new Error(`Claude messages.stream failed: ${response.status} (no response body)`);
      }

      // Anthropic splits usage across events: message_start carries input tokens
      // (and the request id), message_delta carries the final output token count.
      let requestId: string | undefined;
      const usage: ClaudeUsagePayload = {};
      let sawUsage = false;
      for await (const data of parseSseEvents(response.body)) {
        if (data === "[DONE]") {
          continue;
        }

        const payload = JSON.parse(data) as {
          type?: string;
          delta?: { type?: string; text?: string };
          message?: { id?: string; usage?: ClaudeUsagePayload };
          usage?: ClaudeUsagePayload;
        };

        if (payload.type === "message_start") {
          requestId = payload.message?.id ?? requestId;
          const startUsage = payload.message?.usage;
          if (startUsage) {
            usage.input_tokens = startUsage.input_tokens ?? usage.input_tokens;
            usage.cache_read_input_tokens =
              startUsage.cache_read_input_tokens ?? usage.cache_read_input_tokens;
            sawUsage = true;
          }
        } else if (payload.type === "message_delta" && payload.usage) {
          usage.output_tokens = payload.usage.output_tokens ?? usage.output_tokens;
          sawUsage = true;
        } else if (
          payload.type === "content_block_delta"
          && payload.delta?.type === "text_delta"
          && payload.delta.text
        ) {
          yield payload.delta.text;
        }
      }

      return sawUsage ? buildClaudeUsage({ usage, requestId }) : undefined;
    });
  }
}
