import { describe, expect, it } from "vitest";

import {
  ModelGroundedMissResponseComposer,
} from "../../src/modules/chat/services/groundedMissResponseComposer.js";

describe("grounded miss response composer", () => {
  it("lets the model compose the full no-context response", async () => {
    const composer = new ModelGroundedMissResponseComposer({
      metadata: {
        capability: "chat",
        provider: "openai",
        model: "test-model",
      },
      async complete() {
        return "MODEL_NO_CONTEXT";
      },
      async *stream() {
        yield "";
      },
    });

    await expect(
      composer.composeNoContext({
        query: "What is the capital of France?",
      }),
    ).resolves.toBe("MODEL_NO_CONTEXT");
  });

  it("requests minimal reasoning effort with budget for the decline so reasoning models don't return empty", async () => {
    let observedRequest: { maxOutputTokens?: number; reasoningEffort?: string } = {};
    const composer = new ModelGroundedMissResponseComposer({
      metadata: { capability: "chat", provider: "openai", model: "gpt-5-nano" },
      async complete(request) {
        observedRequest = request;
        return "MODEL_NO_CONTEXT";
      },
      async *stream() {
        yield "";
      },
    });

    await composer.composeNoContext({ query: "What is the capital of France?" });

    expect(observedRequest.reasoningEffort).toBe("minimal");
    expect(observedRequest.maxOutputTokens ?? 0).toBeGreaterThanOrEqual(256);
  });

  it("passes assistant scope instructions into no-context generation", async () => {
    let observedPrompt = "";
    const composer = new ModelGroundedMissResponseComposer({
      metadata: {
        capability: "chat",
        provider: "openai",
        model: "test-model",
      },
      async complete({ prompt }) {
        observedPrompt = prompt;
        return "MODEL_NO_CONTEXT";
      },
      async *stream() {
        yield "";
      },
    });

    await composer.composeNoContext({
      query: "I like potato chips",
      answerInstructionBlock: "Configured response instructions:\nHelp visitors choose and book Ananda courses.",
    });

    expect(observedPrompt).toContain("Answer Instructions:");
    expect(observedPrompt).toContain("Help visitors choose and book Ananda courses.");
    expect(observedPrompt).toContain("Redirect back to the Answer Instructions scope");
    expect(observedPrompt).toContain("Do not offer to help with unrelated topics from the user query");
    expect(observedPrompt).toContain("Do not mention internal labels");
  });

  it("forbids librarian phrasing in the grounded-miss prompt rules", async () => {
    let observedPrompt = "";
    const composer = new ModelGroundedMissResponseComposer({
      metadata: {
        capability: "chat",
        provider: "openai",
        model: "test-model",
      },
      async complete({ prompt }) {
        observedPrompt = prompt;
        return "MODEL_NO_CONTEXT";
      },
      async *stream() {
        yield "";
      },
    });

    await composer.composeNoContext({ query: "Draft a follow-up" });

    expect(observedPrompt).toContain("Decline directly in the team's voice");
    expect(observedPrompt).toContain('Do not say "I don\'t have that information,"');
    expect(observedPrompt).toContain("anything that references documents, materials, sources, search, or retrieval");
  });

  it("passes explicit locale guidance into grounded-miss generation", async () => {
    const composer = new ModelGroundedMissResponseComposer({
      metadata: {
        capability: "chat",
        provider: "openai",
        model: "test-model",
      },
      async complete() {
        return "MODEL_LOCALE_SPECIFIC";
      },
      async *stream() {
        yield "";
      },
    });

    await expect(
      composer.composeNoContext({
        query: "Qual e il prezzo del corso?",
        userExpectedLocale: "it-IT",
      }),
    ).resolves.toBe("MODEL_LOCALE_SPECIFIC");
  });

  it("falls back when the no-context model output is empty", async () => {
    const composer = new ModelGroundedMissResponseComposer({
      metadata: {
        capability: "chat",
        provider: "openai",
        model: "test-model",
      },
      async complete() {
        return "   ";
      },
      async *stream() {
        yield "";
      },
    });

    const fallback = await composer.composeNoContext({ query: "What is the capital of France?" });
    expect(fallback).toEqual(expect.any(String));
    expect(fallback.length).toBeGreaterThan(0);
  });

  it("falls back when no-context generation returns empty output for another locale", async () => {
    const composer = new ModelGroundedMissResponseComposer({
      metadata: {
        capability: "chat",
        provider: "openai",
        model: "test-model",
      },
      async complete() {
        return "   ";
      },
      async *stream() {
        yield "";
      },
    });

    const fallback = await composer.composeNoContext({ query: "Qual è la capitale della Francia?" });
    expect(fallback).toEqual(expect.any(String));
    expect(fallback.length).toBeGreaterThan(0);
  });

  it("falls back without trying to infer locale from ambiguous English tokens", async () => {
    const composer = new ModelGroundedMissResponseComposer({
      metadata: {
        capability: "chat",
        provider: "openai",
        model: "test-model",
      },
      async complete() {
        return "   ";
      },
      async *stream() {
        yield "";
      },
    });

    const fallback = await composer.composeNoContext({ query: "Was changed in the pricing docs?" });
    expect(fallback).toEqual(expect.any(String));
    expect(fallback.length).toBeGreaterThan(0);
  });

  it("propagates provider credential errors instead of masking them with fallback copy", async () => {
    const composer = new ModelGroundedMissResponseComposer({
      metadata: {
        capability: "chat",
        provider: "openai",
        model: "test-model",
      },
      async complete() {
        throw {
          status: 401,
          code: "invalid_api_key",
          error: {
            message: "Incorrect API key provided.",
            code: "invalid_api_key",
          },
        };
      },
      async *stream() {
        yield "";
      },
    });

    await expect(
      composer.composeNoContext({ query: "What is the capital of France?" }),
    ).rejects.toMatchObject({
      status: 401,
      code: "invalid_api_key",
    });
  });
});
