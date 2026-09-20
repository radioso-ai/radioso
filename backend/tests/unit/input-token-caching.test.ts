import { describe, expect, it } from "vitest";

import {
  createReusableInputBoundary,
  normalizeCacheAccounting,
  renderSystemPromptWithReusableInputBoundary,
} from "../../src/shared/infra/llm/inputTokenCaching.js";

describe("input token caching boundary", () => {
  it("renders the exact stable system prefix followed by dynamic system material", () => {
    const boundary = createReusableInputBoundary({
      stableSystemPrefix: "standing instructions\n",
      dynamicSystemSuffix: "today is private",
    });

    expect(boundary).toEqual({
      stableSystemPrefix: "standing instructions\n",
      dynamicSystemSuffix: "today is private",
    });
    expect(renderSystemPromptWithReusableInputBoundary(boundary!)).toBe("standing instructions\ntoday is private");
  });

  it("safely ignores invalid boundary metadata", () => {
    expect(createReusableInputBoundary({ stableSystemPrefix: "", dynamicSystemSuffix: "dynamic" })).toBeUndefined();
    expect(createReusableInputBoundary({ stableSystemPrefix: "stable", dynamicSystemSuffix: Number.NaN as unknown as string })).toBeUndefined();
  });
});

describe("cache accounting normalization", () => {
  it("preserves reported zero separately from unknown accounting and omits invalid counts", () => {
    expect(normalizeCacheAccounting({ readInputTokens: 0, writeInputTokens: 0 })).toEqual({
      state: "reported",
      readInputTokens: 0,
      writeInputTokens: 0,
    });
    expect(normalizeCacheAccounting({})).toEqual({ state: "unknown" });
    expect(normalizeCacheAccounting({ readInputTokens: -1, writeInputTokens: Number.POSITIVE_INFINITY })).toEqual({
      state: "unknown",
    });
  });
});
