import { describe, expect, it } from "vitest";

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
    const composer = new ModelGroundedMissResponseComposer({
      async complete() {
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
  });

  it("builds the default no-context response", async () => {
    const composer = new DefaultGroundedMissResponseComposer();

    await expect(
      composer.composeNoContext(),
    ).resolves.toBe(DEFAULT_NO_CONTEXT_RESPONSE);
  });
});
