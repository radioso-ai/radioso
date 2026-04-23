import { describe, expect, it } from "vitest";
import type { TextGenerationRequest } from "../../src/shared/infra/llm/providerTypes.js";

import {
  MissingGroundedMissResponseComposer,
  ModelGroundedMissResponseComposer,
} from "../../src/modules/chat/services/groundedMissResponseComposer.js";

describe("grounded miss response composer", () => {
  it("falls back to deterministic copy when no grounded-miss composer is configured", async () => {
    const composer = new MissingGroundedMissResponseComposer();

    await expect(
      composer.composeUnsupportedWithContext({
        query: "I need a raspberry cake recipe",
        unsupportedText: "Here is a raspberry cake recipe.",
        contexts: [{ title: "Workspace Guide", content: "" }],
      }),
    ).resolves.toBe(
      "I couldn't verify that from your workspace documents, but I did find related material in \"Workspace Guide\" if you'd like to explore that instead.",
    );

    await expect(
      composer.composeNoContext({ query: "What is the capital of France?" }),
    ).resolves.toBe(
      "I couldn't find supporting material for that in your workspace documents. If you'd like, try asking about a topic that's covered there.",
    );
  });

  it("lets the model compose the full unsupported response from retrieved contexts", async () => {
    let request: TextGenerationRequest | undefined;
    const composer = new ModelGroundedMissResponseComposer({
      metadata: {
        capability: "chat",
        provider: "openai",
        model: "test-model",
      },
      async complete(input) {
        request = input;
        return "I couldn't verify a raspberry cake recipe here.\n\nIf you'd like, I can still help with:\n1. vegetarian cuisine\n2. mindful cooking";
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
    ).resolves.toBe("I couldn't verify a raspberry cake recipe here.\n\nIf you'd like, I can still help with:\n1. vegetarian cuisine\n2. mindful cooking");

    expect(request?.systemPrompt).toContain(
      "naturally pivot to the strongest nearby topic you can honestly help with",
    );
    expect(request?.prompt).toContain("Context 1:");
    expect(request?.prompt).toContain("Title: Ananda Vegetarian Cuisine");
    expect(request?.prompt).toContain("Excerpt: Ananda talks about vegetarian cuisine and mindful cooking.");
    expect(request?.prompt).toContain("Conversation mode: exploratory.");
    expect(request?.prompt).toContain("two or three nearby directions you can honestly help with from what you have here");
  });

  it("lets the model compose the full no-context response", async () => {
    let request: TextGenerationRequest | undefined;
    const composer = new ModelGroundedMissResponseComposer({
      metadata: {
        capability: "chat",
        provider: "openai",
        model: "test-model",
      },
      async complete(input) {
        request = input;
        return "I couldn't find relevant material in the workspace for that question.";
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
    ).resolves.toBe("I couldn't find relevant material in the workspace for that question.");

    expect(request?.prompt).toContain("What is the capital of France?");
    expect(request?.prompt).toContain("Conversation mode: guided.");
    expect(request?.prompt).toContain("one concise next-step hint");
  });

  it("passes explicit locale guidance into grounded-miss generation", async () => {
    let request: TextGenerationRequest | undefined;
    const composer = new ModelGroundedMissResponseComposer({
      metadata: {
        capability: "chat",
        provider: "openai",
        model: "test-model",
      },
      async complete(input) {
        request = input;
        return "Non posso verificarlo con certezza.";
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
    ).resolves.toBe("Non posso verificarlo con certezza.");

    expect(request?.systemPrompt).toContain("Write the response in locale it-IT.");
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

    await expect(
      composer.composeUnsupportedWithContext({
        query: "I need a raspberry cake recipe",
        unsupportedText: "Here is a raspberry cake recipe.",
        contexts: [
          {
            title: "Ananda Vegetarian Cuisine",
            content: "Ananda talks about vegetarian cuisine and mindful cooking.",
          },
        ],
      }),
    ).resolves.toBe(
      "I couldn't verify that from your workspace documents, but I did find related material in \"Ananda Vegetarian Cuisine\" if you'd like to explore that instead.",
    );
  });

  it("preserves markdown-style structure in unsupported-with-context model output", async () => {
    const composer = new ModelGroundedMissResponseComposer({
      metadata: {
        capability: "chat",
        provider: "openai",
        model: "test-model",
      },
      async complete() {
        return "First paragraph.\n\n- one\n- two[[1]]";
      },
      async *stream() {
        yield "";
      },
    });

    await expect(
      composer.composeUnsupportedWithContext({
        query: "What now?",
        unsupportedText: "unsupported",
        contexts: [{ title: "Nearby", content: "Nearby content." }],
      }),
    ).resolves.toBe("First paragraph.\n\n- one\n- two");
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

    await expect(
      composer.composeUnsupportedWithContext({
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
      }),
    ).resolves.toBe(
      "I couldn't verify that from your workspace documents, but I did find related material in \"Ananda Vegetarian Cuisine\" if you'd like to explore that instead.",
    );
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

    await expect(
      composer.composeNoContext({ query: "What is the capital of France?" }),
    ).resolves.toBe(
      "I couldn't find supporting material for that in your workspace documents. If you'd like, try asking about a topic that's covered there.",
    );
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

    await expect(
      composer.composeNoContext({ query: "Qual è la capitale della Francia?" }),
    ).resolves.toBe(
      "I couldn't find supporting material for that in your workspace documents. If you'd like, try asking about a topic that's covered there.",
    );
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

    await expect(
      composer.composeNoContext({ query: "Was changed in the pricing docs?" }),
    ).resolves.toBe(
      "I couldn't find supporting material for that in your workspace documents. If you'd like, try asking about a topic that's covered there.",
    );
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

    await expect(
      composer.composeUnsupportedWithContext({
        query: "Onde estao os documentos?",
        unsupportedText: "Nao consegui verificar isso.",
        contexts: [
          {
            title: "Workspace Guide",
            content: "This workspace covers onboarding and pricing policies.",
          },
        ],
      }),
    ).resolves.toBe(
      "I couldn't verify that from your workspace documents, but I did find related material in \"Workspace Guide\" if you'd like to explore that instead.",
    );
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
