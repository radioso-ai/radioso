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
