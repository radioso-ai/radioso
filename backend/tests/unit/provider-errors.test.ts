import { describe, expect, it } from "vitest";

import {
  ProviderHttpError,
  isPermanentProviderFailure,
} from "../../src/shared/infra/llm/providerErrors.js";
import { ProviderRequestTimeoutError } from "../../src/shared/infra/llm/providerTimeouts.js";

describe("isPermanentProviderFailure", () => {
  it("treats raw fetch-style ProviderHttpError 4xx as permanent (Gemini/Claude path)", () => {
    const error = new ProviderHttpError({ provider: "Gemini", operation: "embedContent", status: 400 });
    expect(isPermanentProviderFailure(error)).toBe(true);
  });

  it("treats ProviderHttpError 401 as permanent via credential detection", () => {
    const error = new ProviderHttpError({ provider: "Claude", operation: "messages", status: 401 });
    expect(isPermanentProviderFailure(error)).toBe(true);
  });

  it("treats ProviderHttpError 5xx as transient", () => {
    const error = new ProviderHttpError({ provider: "Gemini", operation: "generate", status: 503 });
    expect(isPermanentProviderFailure(error)).toBe(false);
  });

  it("does not classify retryable 4xx (408/409/425/429) as permanent", () => {
    for (const status of [408, 409, 425, 429]) {
      const error = new ProviderHttpError({ provider: "Gemini", operation: "generate", status });
      expect(isPermanentProviderFailure(error)).toBe(false);
    }
  });

  it("treats OpenAI SDK-style errors with status as permanent for 4xx", () => {
    const error = { status: 422, code: "invalid_request_error" };
    expect(isPermanentProviderFailure(error)).toBe(true);
  });

  it("treats request timeouts as transient", () => {
    const error = new ProviderRequestTimeoutError("OpenAI embeddings request", 60_000);
    expect(isPermanentProviderFailure(error)).toBe(false);
  });

  it("returns false for plain Error without status (the previous Gemini failure mode)", () => {
    expect(isPermanentProviderFailure(new Error("Gemini embedding request failed: 400"))).toBe(false);
  });
});

describe("ProviderHttpError typed code", () => {
  const bodyFor = (inner: Record<string, unknown>) => ({ error: inner });

  it("carries the provider's structural code for non-credential failures", () => {
    const error = new ProviderHttpError({
      provider: "Claude",
      operation: "messages",
      status: 400,
      bodyJson: bodyFor({ type: "invalid_request_error", message: "customer text" }),
    });
    expect(error.code).toBe("invalid_request_error");
  });

  it("prefers the provider code, then its status enum", () => {
    expect(new ProviderHttpError({
      provider: "Gemini",
      operation: "generate",
      status: 429,
      bodyJson: bodyFor({ status: "RESOURCE_EXHAUSTED", message: "customer text" }),
    }).code).toBe("RESOURCE_EXHAUSTED");
    expect(new ProviderHttpError({
      provider: "OpenAI-compatible",
      operation: "chat",
      status: 400,
      bodyJson: bodyFor({ code: "context_length_exceeded", type: "invalid_request_error" }),
    }).code).toBe("context_length_exceeded");
  });

  it("keeps invalid_api_key for credential failures", () => {
    const error = new ProviderHttpError({
      provider: "Gemini",
      operation: "generate",
      status: 400,
      bodyJson: bodyFor({ status: "INVALID_ARGUMENT", message: "API key not valid" }),
    });
    expect(error.code).toBe("invalid_api_key");
  });

  it("never takes prose from the body as its code", () => {
    const error = new ProviderHttpError({
      provider: "OpenAI-compatible",
      operation: "chat",
      status: 400,
      bodyJson: bodyFor({ code: "customer jane@example.org rejected", message: "customer text" }),
    });
    expect(error.code).toBe("provider_http_error");
  });

  it("falls back to a generic code when the body carries none", () => {
    const error = new ProviderHttpError({ provider: "Gemini", operation: "generate", status: 503 });
    expect(error.code).toBe("provider_http_error");
  });
});
