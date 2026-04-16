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
      composer.composeNoContext({ query: "What is the capital of France?" }),
    ).resolves.toBe("I couldn't find relevant material in the workspace for that question.");

    expect(request?.prompt).toContain("What is the capital of France?");
  });
});
