import { afterEach, describe, expect, it, vi } from "vitest";

import { GeminiEmbeddingClient } from "../../src/shared/infra/llm/geminiProvider.js";
import { OpenAIEmbeddingClient } from "../../src/shared/infra/llm/openaiProvider.js";
import { getProviderFailureReason } from "../../src/shared/infra/llm/providerErrors.js";
import {
  EMBEDDING_REQUEST_TIMEOUT_MS,
  ProviderRequestTimeoutError,
} from "../../src/shared/infra/llm/providerTimeouts.js";

const openAiEmbeddingConfig = {
  capability: "embeddings" as const,
  provider: "openai" as const,
  model: "text-embedding-3-small",
  apiKey: "openai-key",
};

const geminiEmbeddingConfig = {
  capability: "embeddings" as const,
  provider: "gemini" as const,
  model: "gemini-embedding-001",
  apiKey: "gemini-key",
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("embedding provider timeouts", () => {
  it("aborts OpenAI embedding requests after the provider timeout", async () => {
    vi.useFakeTimers();
    const client = new OpenAIEmbeddingClient(openAiEmbeddingConfig);
    let capturedSignal: AbortSignal | undefined;

    (
      client as unknown as {
        client: {
          embeddings: {
            create(
              input: Record<string, unknown>,
              options?: { signal?: AbortSignal },
            ): Promise<{ data: Array<{ embedding: number[] }> }>;
          };
        };
      }
    ).client.embeddings.create = vi.fn((_input, options): Promise<{ data: Array<{ embedding: number[] }> }> => {
      capturedSignal = options?.signal;
      return new Promise(() => {});
    });

    const request = client.embedTexts(["hello"]);
    const expectation = expect(request).rejects.toMatchObject({
      name: "ProviderRequestTimeoutError",
      operation: "OpenAI embeddings request",
      timeoutMs: EMBEDDING_REQUEST_TIMEOUT_MS,
    });

    await vi.advanceTimersByTimeAsync(EMBEDDING_REQUEST_TIMEOUT_MS);

    await expectation;
    expect(capturedSignal?.aborted).toBe(true);
  });

  it("aborts Gemini embedding requests after the provider timeout", async () => {
    vi.useFakeTimers();
    const client = new GeminiEmbeddingClient(geminiEmbeddingConfig);
    let capturedSignal: AbortSignal | undefined;

    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string | URL | Request, init?: RequestInit) => {
        capturedSignal = init?.signal instanceof AbortSignal ? init.signal : undefined;
        return new Promise(() => {});
      }),
    );

    const request = client.embedTexts(["hello"]);
    const expectation = expect(request).rejects.toMatchObject({
      name: "ProviderRequestTimeoutError",
      operation: "Gemini embeddings request",
      timeoutMs: EMBEDDING_REQUEST_TIMEOUT_MS,
    });

    await vi.advanceTimersByTimeAsync(EMBEDDING_REQUEST_TIMEOUT_MS);

    await expectation;
    expect(capturedSignal?.aborted).toBe(true);
  });

  it("uses a stable transient failure reason for provider timeouts", () => {
    expect(
      getProviderFailureReason(
        new ProviderRequestTimeoutError("OpenAI embeddings request", EMBEDDING_REQUEST_TIMEOUT_MS),
      ),
    ).toBe("OpenAI embeddings request timed out after 60000ms");
  });
});
