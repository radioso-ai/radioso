import { describe, expect, it } from "vitest";

import { streamWithUsage } from "../../src/shared/infra/llm/providerStreaming.js";

describe("provider streaming adapter", () => {
  it("closes the provider iterator when the caller stops consuming early", async () => {
    let closed = false;
    const result = streamWithUsage(async function* () {
      try {
        yield "first";
        yield "second";
        return {
          inputTokens: 1,
          outputTokens: 2,
          totalTokens: 3,
          quality: "actual" as const,
        };
      } finally {
        closed = true;
      }
    });

    const iterator = result.textStream[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({ value: "first", done: false });
    await iterator.return?.();

    expect(closed).toBe(true);
    await expect(result.usage).resolves.toBeUndefined();
  });

  it("captures usage reported by provider cleanup after an early return", async () => {
    const providerUsage = {
      inputTokens: 4,
      outputTokens: 1,
      totalTokens: 5,
      quality: "actual" as const,
    };
    const result = streamWithUsage(async function* () {
      try {
        yield "first";
        yield "second";
      } finally {
        return providerUsage;
      }
    });
    const iterator = result.textStream[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({ value: "first", done: false });
    await iterator.return?.();

    await expect(result.usage).resolves.toEqual(providerUsage);
  });
});
