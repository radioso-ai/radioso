import { describe, expect, it } from "vitest";

import { buildChatSamplingParams } from "../../src/shared/infra/llm/openaiProvider.js";

describe("buildChatSamplingParams", () => {
  it("sends temperature and a completion-token cap by default", () => {
    expect(buildChatSamplingParams("openai", { temperature: 0, maxOutputTokens: 80 })).toEqual({
      temperature: 0,
      max_completion_tokens: 80,
    });
  });

  it("forwards reasoning_effort and drops temperature for openai reasoning calls", () => {
    const params = buildChatSamplingParams("openai", {
      temperature: 0,
      maxOutputTokens: 512,
      reasoningEffort: "minimal",
    });

    expect(params).toEqual({ max_completion_tokens: 512, reasoning_effort: "minimal" });
    expect(params).not.toHaveProperty("temperature");
  });

  it("does not send reasoning_effort to openai-compatible endpoints", () => {
    const params = buildChatSamplingParams("openai-compatible", {
      temperature: 0.2,
      maxOutputTokens: 100,
      reasoningEffort: "minimal",
    });

    expect(params).toEqual({ temperature: 0.2, max_tokens: 100 });
  });

  it("normalizes none to minimal for pre-5.4 gpt-5 models", () => {
    const params = buildChatSamplingParams("openai", {
      temperature: 0,
      maxOutputTokens: 512,
      reasoningEffort: "none",
    }, "gpt-5-nano");

    expect(params).toEqual({ max_completion_tokens: 512, reasoning_effort: "minimal" });
  });

  it("normalizes minimal to none for gpt-5.4 models", () => {
    const params = buildChatSamplingParams("openai", {
      temperature: 0,
      maxOutputTokens: 512,
      reasoningEffort: "minimal",
    }, "gpt-5.4-mini");

    expect(params).toEqual({ max_completion_tokens: 512, reasoning_effort: "none" });
  });
});
