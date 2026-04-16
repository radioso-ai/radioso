import { describe, expect, it } from "vitest";
import type { TextGenerationRequest } from "../../src/shared/infra/llm/providerTypes.js";

import {
  DEFAULT_NO_CONTEXT_RESPONSE,
  DefaultGroundedMissResponseComposer,
  ModelGroundedMissResponseComposer,
  DEFAULT_UNSUPPORTED_WITHOUT_CONTEXT_RESPONSE,
} from "../../src/modules/chat/services/groundedMissResponseComposer.js";

describe("grounded miss response composer", () => {
  it("uses the generic fallback for unsupported responses in the default composer", async () => {
    const composer = new DefaultGroundedMissResponseComposer();

    await expect(
      composer.composeUnsupportedWithContext({
        query: "I need a raspberry cake recipe",
        unsupportedText: "Here is a raspberry cake recipe.",
        contexts: [
          {
            title: "Ananda Vegetarian Cuisine",
            content: "vegetarian cuisine and mindful cooking tips",
          },
        ],
      }),
    ).resolves.toBe(
      'I couldn\'t verify that from your workspace documents, but I did find related material in "Ananda Vegetarian Cuisine" if you\'d like to explore that instead.',
    );
  });

  it("falls back to the generic unsupported response when there is no useful title or content topic", async () => {
    const composer = new DefaultGroundedMissResponseComposer();

    await expect(
      composer.composeUnsupportedWithContext({
        query: "I need a raspberry cake recipe",
        unsupportedText: "Here is a raspberry cake recipe.",
        contexts: [{ title: "", content: "" }],
      }),
    ).resolves.toBe(DEFAULT_UNSUPPORTED_WITHOUT_CONTEXT_RESPONSE);
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
  });

  it("builds the default no-context response", async () => {
    const composer = new DefaultGroundedMissResponseComposer();

    await expect(
      composer.composeNoContext({ query: "What is the capital of France?" }),
    ).resolves.toBe(DEFAULT_NO_CONTEXT_RESPONSE);
  });

  it("adds a narrower next-step hint for exploratory no-context responses", async () => {
    const composer = new DefaultGroundedMissResponseComposer();

    await expect(
      composer.composeNoContext({ query: "What is the capital of France?", conversationMode: "exploratory" }),
    ).resolves.toBe(`${DEFAULT_NO_CONTEXT_RESPONSE} If you want, ask about a document title, section name, or exact phrase and I can search for that.`);
  });
});
