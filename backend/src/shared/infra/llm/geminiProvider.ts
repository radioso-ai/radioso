import {
  type EmbeddingClient,
  type EmbeddingResult,
  type LlmCapabilityConfig,
  type ProviderUsage,
  type TextGenerationClient,
  type TextGenerationRequest,
  type TextGenerationResult,
  type TextGenerationStreamResult,
} from "./providerTypes.js";
import { readProviderErrorBody } from "./providerErrors.js";
import { streamWithUsage } from "./providerStreaming.js";
import { EMBEDDING_REQUEST_TIMEOUT_MS, runProviderRequestWithTimeout } from "./providerTimeouts.js";
import { parseSseEvents } from "./sse.js";

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const STORAGE_VECTOR_DIMENSIONS = 1536;

const buildGenerateBody = (input: {
  prompt: string;
  systemPrompt?: string;
  temperature?: number;
  maxOutputTokens?: number;
  responseFormat?: TextGenerationRequest["responseFormat"];
}) => ({
  contents: [
    {
      role: "user",
      parts: [{ text: input.prompt }],
    },
  ],
  ...(input.systemPrompt
    ? {
        systemInstruction: {
          parts: [{ text: input.systemPrompt }],
        },
      }
    : {}),
  generationConfig: {
    temperature: input.temperature,
    maxOutputTokens: input.maxOutputTokens,
    ...(input.responseFormat
      ? {
          responseMimeType: "application/json",
          responseJsonSchema: input.responseFormat.schema,
        }
      : {}),
  },
});

const extractGeminiText = (payload: unknown): string => {
  const candidate = (payload as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> })?.candidates?.[0];
  return candidate?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
};

interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
}

const extractGeminiUsage = (payload: unknown): ProviderUsage | undefined => {
  const usage = (payload as { usageMetadata?: GeminiUsageMetadata })?.usageMetadata;
  if (!usage) {
    return undefined;
  }
  return {
    inputTokens: usage.promptTokenCount,
    outputTokens: usage.candidatesTokenCount,
    totalTokens: usage.totalTokenCount,
    cachedInputTokens: usage.cachedContentTokenCount,
    quality: "actual",
  };
};

export class GeminiTextGenerationClient implements TextGenerationClient {
  readonly metadata;

  constructor(private readonly config: LlmCapabilityConfig) {
    this.metadata = {
      capability: config.capability,
      provider: config.provider,
      model: config.model,
    };
  }

  async complete(input: TextGenerationRequest): Promise<TextGenerationResult> {
    const response = await fetch(
      `${GEMINI_BASE_URL}/${this.config.model}:generateContent?key=${encodeURIComponent(this.config.apiKey)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        signal: input.signal,
        body: JSON.stringify(buildGenerateBody(input)),
      },
    );

    if (!response.ok) {
      throw await readProviderErrorBody("Gemini", "generate", response);
    }

    const payload = await response.json();
    return {
      text: extractGeminiText(payload),
      usage: extractGeminiUsage(payload),
    };
  }

  stream(input: TextGenerationRequest): TextGenerationStreamResult {
    const config = this.config;
    return streamWithUsage(async function* () {
      const response = await fetch(
        `${GEMINI_BASE_URL}/${config.model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(config.apiKey)}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          signal: input.signal,
          body: JSON.stringify(buildGenerateBody(input)),
        },
      );

      if (!response.ok) {
        throw await readProviderErrorBody("Gemini", "stream", response);
      }
      if (!response.body) {
        throw new Error(`Gemini stream failed: ${response.status} (no response body)`);
      }

      // Gemini reports cumulative usageMetadata on streamed chunks; keep the latest.
      let usage: ProviderUsage | undefined;
      for await (const data of parseSseEvents(response.body)) {
        if (data === "[DONE]") {
          continue;
        }

        const payload = JSON.parse(data) as unknown;
        const text = extractGeminiText(payload);
        if (text) {
          yield text;
        }
        usage = extractGeminiUsage(payload) ?? usage;
      }
      return usage;
    });
  }
}

export class GeminiEmbeddingClient implements EmbeddingClient {
  readonly metadata;

  constructor(private readonly config: LlmCapabilityConfig) {
    this.metadata = {
      capability: config.capability,
      provider: config.provider,
      model: config.model,
    };
  }

  async embedTexts(texts: string[], options?: { model?: string }): Promise<EmbeddingResult> {
    const embeddings: number[][] = [];
    const model = options?.model ?? this.config.model;
    let promptTokens: number | undefined;

    for (const text of texts) {
      const response = await runProviderRequestWithTimeout(
        "Gemini embeddings request",
        EMBEDDING_REQUEST_TIMEOUT_MS,
        (signal) =>
          fetch(
            `${GEMINI_BASE_URL}/${model}:embedContent?key=${encodeURIComponent(this.config.apiKey)}`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              signal,
              body: JSON.stringify({
                model: `models/${model}`,
                output_dimensionality: STORAGE_VECTOR_DIMENSIONS,
                content: {
                  parts: [{ text }],
                },
              }),
            },
          ),
      );

      if (!response.ok) {
        throw await readProviderErrorBody("Gemini", "embedContent", response);
      }

      const payload = (await response.json()) as {
        embedding?: { values?: number[] };
        usageMetadata?: GeminiUsageMetadata;
      };
      embeddings.push(payload.embedding?.values ?? []);
      const tokens = payload.usageMetadata?.promptTokenCount ?? payload.usageMetadata?.totalTokenCount;
      if (typeof tokens === "number") {
        promptTokens = (promptTokens ?? 0) + tokens;
      }
    }

    return {
      vectors: embeddings,
      usage:
        promptTokens === undefined
          ? undefined
          : { inputTokens: promptTokens, totalTokens: promptTokens, quality: "actual" },
    };
  }
}
