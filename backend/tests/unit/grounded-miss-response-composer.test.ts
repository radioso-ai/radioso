import { describe, expect, it } from "vitest";
import type { TextGenerationRequest } from "../../src/shared/infra/llm/providerTypes.js";

import {
  MissingGroundedMissResponseComposer,
  ModelGroundedMissResponseComposer,
} from "../../src/modules/chat/services/groundedMissResponseComposer.js";

describe("grounded miss response composer", () => {
  it("fails fast when no grounded-miss composer is configured", async () => {
    const composer = new MissingGroundedMissResponseComposer();

    await expect(
      composer.composeUnsupportedWithContext({
        query: "I need a raspberry cake recipe",
        unsupportedText: "Here is a raspberry cake recipe.",
        contexts: [{ title: "", content: "" }],
      }),
    ).rejects.toThrow("grounded_miss_response_composer_not_configured");

    await expect(
      composer.composeNoContext({ query: "What is the capital of France?" }),
    ).rejects.toThrow("grounded_miss_response_composer_not_configured");
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
        return "I couldn't verify a raspberry cake recipe here, but I did find material about vegetarian cuisine in Ananda Vegetarian Cuisine if you'd like to explore that instead.";
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
    ).resolves.toBe(
      "I couldn't verify a raspberry cake recipe here, but I did find material about vegetarian cuisine in Ananda Vegetarian Cuisine if you'd like to explore that instead.",
    );

    expect(request?.systemPrompt).toContain(
      "point the user toward the strongest nearby topic or source from those contexts",
    );
    expect(request?.prompt).toContain("Context 1:");
    expect(request?.prompt).toContain("Title: Ananda Vegetarian Cuisine");
    expect(request?.prompt).toContain("Excerpt: Ananda talks about vegetarian cuisine and mindful cooking.");
    expect(request?.prompt).toContain("Conversation mode: exploratory.");
    expect(request?.prompt).toContain("two or three grounded adjacent directions");
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

  it("falls back to the deterministic unsupported-with-context refusal when generation fails", async () => {
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
      `I couldn't verify that from your workspace documents, but I did find related material in "Ananda Vegetarian Cuisine" if you'd like to explore that instead.`,
    );
  });

  it("uses the first available titled context in the fallback even if earlier contexts are untitled", async () => {
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
      `I couldn't verify that from your workspace documents, but I did find related material in "Ananda Vegetarian Cuisine" if you'd like to explore that instead.`,
    );
  });

  it("falls back to the deterministic no-context refusal when the model returns empty output", async () => {
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

  it("uses the shared default no-context fallback template when generation fails", async () => {
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

  it("does not switch fallback languages for ambiguous English tokens", async () => {
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

  it("does not branch into another locale for shared Romance-language tokens", async () => {
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
      `I couldn't verify that from your workspace documents, but I did find related material in "Workspace Guide" if you'd like to explore that instead.`,
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
