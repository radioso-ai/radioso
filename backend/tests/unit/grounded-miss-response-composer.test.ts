import { describe, expect, it } from "vitest";

import {
  DEFAULT_NO_CONTEXT_RESPONSE,
  DefaultGroundedMissResponseComposer,
  DEFAULT_UNSUPPORTED_WITHOUT_CONTEXT_RESPONSE,
} from "../../src/modules/chat/services/groundedMissResponseComposer.js";

describe("grounded miss response composer", () => {
  it("builds a conversational unsupported response from retrieved context titles", async () => {
    const composer = new DefaultGroundedMissResponseComposer();

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
      'I couldn\'t verify that from your workspace documents, but I did find related material in "Ananda Vegetarian Cuisine" if you\'d like to explore that instead.',
    );
  });

  it("falls back to a generic conversational unsupported response when there is no useful title", async () => {
    const composer = new DefaultGroundedMissResponseComposer();

    await expect(
      composer.composeUnsupportedWithContext({
        query: "I need a raspberry cake recipe",
        unsupportedText: "Here is a raspberry cake recipe.",
        contexts: [{ title: "", content: "Vegetarian cuisine and mindful cooking." }],
      }),
    ).resolves.toBe(DEFAULT_UNSUPPORTED_WITHOUT_CONTEXT_RESPONSE);
  });

  it("builds the default no-context response", async () => {
    const composer = new DefaultGroundedMissResponseComposer();

    await expect(
      composer.composeNoContext(),
    ).resolves.toBe(DEFAULT_NO_CONTEXT_RESPONSE);
  });
});
