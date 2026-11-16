import { describe, expect, it, vi } from "vitest";
import OpenAI from "openai";

import {
  providerRetryDelayMs,
  sleepUnlessAborted,
  type ProviderRetryPolicy,
} from "../../src/shared/infra/llm/providerCallRetry.js";
import { parseRetryAfterMs, ProviderHttpError } from "../../src/shared/infra/llm/providerErrors.js";
import { ProviderRequestTimeoutError } from "../../src/shared/infra/llm/providerTimeouts.js";

const policy: ProviderRetryPolicy = { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 2_000 };

const openAIError = (
  Ctor: new (...args: any[]) => InstanceType<typeof OpenAI.APIError>,
  status: number,
  body: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): InstanceType<typeof OpenAI.APIError> => new Ctor(status, body, "message", new Headers(headers));

describe("providerRetryDelayMs", () => {
  it("waits the provider's Retry-After, plus a little jitter, when it fits the cap", () => {
    const error = openAIError(OpenAI.RateLimitError, 429, {}, { "retry-after": "1" });

    expect(providerRetryDelayMs(error, 1, policy, () => 0)).toBe(1_000);
    // Jitter spreads a herd of visitors told to come back at the same instant.
    expect(providerRetryDelayMs(error, 1, policy, () => 1)).toBe(1_250);
  });

  it("prefers the millisecond Retry-After the provider sends", () => {
    const error = openAIError(OpenAI.RateLimitError, 429, {}, { "retry-after-ms": "300", "retry-after": "1" });

    expect(providerRetryDelayMs(error, 1, policy, () => 0)).toBe(300);
  });

  it("does not retry when the provider asks for a longer wait than the turn can spend", () => {
    const error = openAIError(OpenAI.RateLimitError, 429, {}, { "retry-after": "20" });

    expect(providerRetryDelayMs(error, 1, policy, () => 0)).toBeNull();
  });

  it("caps the jittered delay at the policy ceiling", () => {
    const error = openAIError(OpenAI.RateLimitError, 429, {}, { "retry-after": "2" });

    expect(providerRetryDelayMs(error, 1, policy, () => 1)).toBe(2_000);
  });

  it("backs off with equal jitter when the provider names no wait", () => {
    const error = openAIError(OpenAI.InternalServerError, 503);

    expect(providerRetryDelayMs(error, 1, policy, () => 0)).toBe(250);
    expect(providerRetryDelayMs(error, 1, policy, () => 1)).toBe(500);
  });

  it("stops once the attempt budget is spent", () => {
    const error = openAIError(OpenAI.RateLimitError, 429);

    expect(providerRetryDelayMs(error, 2, policy, () => 0)).toBeNull();
  });

  it("never retries an exhausted quota: it does not clear with time", () => {
    const error = openAIError(OpenAI.RateLimitError, 429, { code: "insufficient_quota" });

    expect(providerRetryDelayMs(error, 1, policy, () => 0)).toBeNull();
  });

  it("never retries a call that ran out its own time budget", () => {
    expect(providerRetryDelayMs(new ProviderRequestTimeoutError("answer", 10), 1, policy, () => 0)).toBeNull();
  });

  it("never retries a rejected request or a non-provider failure", () => {
    expect(providerRetryDelayMs(openAIError(OpenAI.BadRequestError, 400), 1, policy, () => 0)).toBeNull();
    expect(providerRetryDelayMs(new Error("bug"), 1, policy, () => 0)).toBeNull();
  });

  it("reads Retry-After from a fetch-based adapter's error", () => {
    const error = new ProviderHttpError({ provider: "claude", operation: "messages", status: 429, retryAfterMs: 700 });

    expect(providerRetryDelayMs(error, 1, policy, () => 0)).toBe(700);
  });
});

describe("parseRetryAfterMs", () => {
  const now = Date.parse("2026-11-16T10:00:00Z");

  it("reads delta-seconds, an HTTP date, and the millisecond variant", () => {
    expect(parseRetryAfterMs(new Headers({ "retry-after": "3" }), now)).toBe(3_000);
    expect(parseRetryAfterMs(new Headers({ "retry-after": "Mon, 16 Nov 2026 10:00:02 GMT" }), now)).toBe(2_000);
    expect(parseRetryAfterMs(new Headers({ "retry-after-ms": "120" }), now)).toBe(120);
  });

  it("ignores an absent or unreadable header", () => {
    expect(parseRetryAfterMs(new Headers(), now)).toBeUndefined();
    expect(parseRetryAfterMs(new Headers({ "retry-after": "soon" }), now)).toBeUndefined();
    expect(parseRetryAfterMs(undefined, now)).toBeUndefined();
  });
});

describe("sleepUnlessAborted", () => {
  it("stops waiting the moment the caller aborts", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const sleeping = sleepUnlessAborted(5_000, controller.signal);
      controller.abort(new Error("turn cancelled"));

      await expect(sleeping).rejects.toThrow("turn cancelled");
    } finally {
      vi.useRealTimers();
    }
  });
});
