import { describe, expect, it } from "vitest";

import { applyRateLimitHeaders, applyRetryAfterFromError } from "../../../src/app/http/rateLimitHeaders.js";

const recordingResponse = () => {
  const headers = new Map<string, string>();
  return {
    headers,
    res: { setHeader: (name: string, value: string | number) => headers.set(name, String(value)) },
  };
};

describe("rate limit headers", () => {
  it("advertises the budget a caller has left and when it refills", () => {
    const { headers, res } = recordingResponse();

    applyRateLimitHeaders(res as never, { limit: 60, remaining: 41, resetAtMs: Date.now() + 12_400 });

    expect(headers.get("RateLimit-Limit")).toBe("60");
    expect(headers.get("RateLimit-Remaining")).toBe("41");
    expect(headers.get("RateLimit-Reset")).toBe("13");
    expect(headers.has("Retry-After")).toBe(false);
  });

  it("rounds a reset that has already passed up to zero rather than negative seconds", () => {
    const { headers, res } = recordingResponse();

    applyRateLimitHeaders(res as never, { limit: 5, remaining: 0, resetAtMs: Date.now() - 5_000 });

    expect(headers.get("RateLimit-Reset")).toBe("0");
  });

  it("tells a blocked caller when to come back", () => {
    const { headers, res } = recordingResponse();

    applyRateLimitHeaders(res as never, {
      limit: 5,
      remaining: 0,
      resetAtMs: Date.now() + 30_000,
      retryAfterSeconds: 30,
    });

    expect(headers.get("Retry-After")).toBe("30");
    expect(headers.get("RateLimit-Remaining")).toBe("0");
  });

  it("re-emits the whole decision a 429 body carries", () => {
    const { headers, res } = recordingResponse();
    const resetAtMs = Date.now() + 45_000;

    applyRetryAfterFromError(res as never, {
      statusCode: 429,
      details: { limit: 10, remaining: 0, resetAtMs, retryAfterSeconds: 45 },
    });

    expect(headers.get("Retry-After")).toBe("45");
    expect(headers.get("RateLimit-Limit")).toBe("10");
    expect(headers.get("RateLimit-Remaining")).toBe("0");
    expect(headers.get("RateLimit-Reset")).toBe("45");
  });

  it("still emits a retry hint for a 429 that carries nothing but the wait", () => {
    const { headers, res } = recordingResponse();

    applyRetryAfterFromError(res as never, { statusCode: 429, details: { retryAfterSeconds: 3_600 } });

    expect(headers.get("Retry-After")).toBe("3600");
    expect(headers.has("RateLimit-Limit")).toBe(false);
  });

  it("leaves responses other than 429 alone", () => {
    const { headers, res } = recordingResponse();

    applyRetryAfterFromError(res as never, { statusCode: 400, details: { retryAfterSeconds: 30 } });
    applyRetryAfterFromError(res as never, { statusCode: 429, details: undefined });
    applyRetryAfterFromError(res as never, { statusCode: 429, details: { retryAfterSeconds: 0 } });

    expect(headers.size).toBe(0);
  });
});
