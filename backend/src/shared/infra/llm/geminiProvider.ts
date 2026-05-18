import {
  type EmbeddingClient,
  type LlmCapabilityConfig,
  type TextGenerationClient,
} from "./providerTypes.js";
import { EMBEDDING_REQUEST_TIMEOUT_MS, runProviderRequestWithTimeout } from "./providerTimeouts.js";
import { parseSseEvents } from "./sse.js";

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const STORAGE_VECTOR_DIMENSIONS = 1536;

const buildGenerateBody = (input: {
  prompt: string;
  systemPrompt?: string;
  temperature?: number;
  maxOutputTokens?: number;
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
  },
});

const extractGeminiText = (payload: unknown): string => {
  const candidate = (payload as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> })?.candidates?.[0];
  return candidate?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
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

  async complete(input: {
    prompt: string;
    systemPrompt?: string;
    temperature?: number;
    maxOutputTokens?: number;
  }): Promise<string> {
    const response = await fetch(
      `${GEMINI_BASE_URL}/${this.config.model}:generateContent?key=${encodeURIComponent(this.config.apiKey)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(buildGenerateBody(input)),
      },
    );

    if (!response.ok) {
      throw new Error(`Gemini request failed: ${response.status}`);
    }

    const payload = await response.json();
    return extractGeminiText(payload);
  }

  async *stream(input: {
    prompt: string;
    systemPrompt?: string;
    temperature?: number;
    maxOutputTokens?: number;
  }): AsyncIterable<string> {
    const response = await fetch(
      `${GEMINI_BASE_URL}/${this.config.model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(this.config.apiKey)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(buildGenerateBody(input)),
      },
    );

    if (!response.ok || !response.body) {
      throw new Error(`Gemini stream failed: ${response.status}`);
    }

    for await (const data of parseSseEvents(response.body)) {
      if (data === "[DONE]") {
        continue;
      }

      const payload = JSON.parse(data) as unknown;
      const text = extractGeminiText(payload);
      if (text) {
        yield text;
      }
    }
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

  async embedTexts(texts: string[], options?: { model?: string }): Promise<number[][]> {
    const embeddings: number[][] = [];
    const model = options?.model ?? this.config.model;

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
        throw new Error(`Gemini embedding request failed: ${response.status}`);
      }

      const payload = (await response.json()) as {
        embedding?: { values?: number[] };
      };
      embeddings.push(payload.embedding?.values ?? []);
    }

    return embeddings;
  }
}
