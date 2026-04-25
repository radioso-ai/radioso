import { describe, expect, it } from "vitest";

import {
  MissingGroundedMissResponseComposer,
  ModelGroundedMissResponseComposer,
} from "../../src/modules/chat/services/groundedMissResponseComposer.js";

describe("grounded miss response composer", () => {
  it("falls back to deterministic copy when no grounded-miss composer is configured", async () => {
    const composer = new MissingGroundedMissResponseComposer();

    const unsupportedWithContext = await composer.composeUnsupportedWithContext({
      query: "I need a raspberry cake recipe",
      unsupportedText: "Here is a raspberry cake recipe.",
      contexts: [{ title: "Workspace Guide", content: "" }],
    });
    expect(unsupportedWithContext).toContain("Workspace Guide");
    expect(unsupportedWithContext.length).toBeGreaterThan(0);

    const noContext = await composer.composeNoContext({ query: "What is the capital of France?" });
    expect(noContext).toEqual(expect.any(String));
    expect(noContext.length).toBeGreaterThan(0);
  });

  it("lets the model compose the full unsupported response from retrieved contexts", async () => {
    const composer = new ModelGroundedMissResponseComposer({
      metadata: {
        capability: "chat",
        provider: "openai",
        model: "test-model",
      },
      async complete() {
        return "MODEL_UNSUPPORTED_WITH_CONTEXT";
      },
      async *stream() {
        yield "";
      },
    });

    await expect(
      composer.composeUnsupportedWithContext({
        query: "I need a raspberry cake recipe",
        unsupportedText: "Here is a raspberry cake recipe.",
        conversationMode: "exploratory",
        contexts: [
          {
            title: "Ananda Vegetarian Cuisine",
            content: "Ananda talks about vegetarian cuisine and mindful cooking.",
          },
        ],
      }),
    ).resolves.toBe("MODEL_UNSUPPORTED_WITH_CONTEXT");
  });

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
        conversationMode: "guided",
      }),
    ).resolves.toBe("MODEL_NO_CONTEXT");
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
      composer.composeUnsupportedWithContext({
        query: "Qual e il prezzo del corso?",
        unsupportedText: "Non posso verificarlo con certezza.",
        userExpectedLocale: "it-IT",
        contexts: [
          {
            title: "Programma",
            content: "Il programma descrive il corso ma non include prezzi.",
          },
        ],
      }),
    ).resolves.toBe("MODEL_LOCALE_SPECIFIC");
  });

  it("falls back when unsupported-with-context generation fails", async () => {
    const composer = new ModelGroundedMissResponseComposer({
      metadata: {
        capability: "chat",
        provider: "openai",
        model: "test-model",
      },
      async complete() {
        throw new Error("transient failure");
      },
      async *stream() {
        yield "";
      },
    });

    const fallback = await composer.composeUnsupportedWithContext({
      query: "I need a raspberry cake recipe",
      unsupportedText: "Here is a raspberry cake recipe.",
      contexts: [
        {
          title: "Ananda Vegetarian Cuisine",
          content: "Ananda talks about vegetarian cuisine and mindful cooking.",
        },
      ],
    });
    expect(fallback).toContain("Ananda Vegetarian Cuisine");
    expect(fallback.length).toBeGreaterThan(0);
  });

  it("uses the first titled context when earlier contexts are untitled", async () => {
    const composer = new ModelGroundedMissResponseComposer({
      metadata: {
        capability: "chat",
        provider: "openai",
        model: "test-model",
      },
      async complete() {
        throw new Error("transient failure");
      },
      async *stream() {
        yield "";
      },
    });

    const fallback = await composer.composeUnsupportedWithContext({
      query: "I need a raspberry cake recipe",
      unsupportedText: "Here is a raspberry cake recipe.",
      contexts: [
        {
          title: "",
          content: "Untitled context that still has content.",
        },
        {
          title: "Ananda Vegetarian Cuisine",
          content: "Ananda talks about vegetarian cuisine and mindful cooking.",
        },
      ],
    });
    expect(fallback).toContain("Ananda Vegetarian Cuisine");
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

  it("falls back without trying to infer locale from shared Romance-language tokens", async () => {
    const composer = new ModelGroundedMissResponseComposer({
      metadata: {
        capability: "chat",
        provider: "openai",
        model: "test-model",
      },
      async complete() {
        throw new Error("transient failure");
      },
      async *stream() {
        yield "";
      },
    });

    const fallback = await composer.composeUnsupportedWithContext({
      query: "Onde estao os documentos?",
      unsupportedText: "Nao consegui verificar isso.",
      contexts: [
        {
          title: "Workspace Guide",
          content: "This workspace covers onboarding and pricing policies.",
        },
      ],
    });
    expect(fallback).toContain("Workspace Guide");
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
