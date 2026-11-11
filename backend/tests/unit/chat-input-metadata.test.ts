import { describe, expect, it } from "vitest";

import {
  chatInputMetadataSchema,
  parseStoredInputMetadata,
  strictChatInputMetadataSchema,
} from "../../src/shared/domain/chatInputMetadata.js";

const SOURCE_MESSAGE_ID = "6f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5";

describe("a clicked chip's id on the input metadata (#1544)", () => {
  it("accepts the chip id with a suggestion click, on the client and the probe schemas alike", () => {
    const click = { method: "suggestion_click", suggestionSourceMessageId: SOURCE_MESSAGE_ID, suggestionId: "agree" };

    expect(chatInputMetadataSchema.parse(click)).toEqual(click);
    expect(strictChatInputMetadataSchema.parse(click)).toEqual(click);
  });

  it("keeps a suggestion click without a chip id valid, as a generated follow-up chip carries none", () => {
    expect(chatInputMetadataSchema.safeParse({ method: "suggestion_click", suggestionSourceMessageId: SOURCE_MESSAGE_ID }).success).toBe(true);
  });

  it("rejects a chip id on anything but a suggestion click, and one that is blank, too long, or not text", () => {
    const rejected = [
      { method: "typed", suggestionId: "agree" },
      { method: "intent_click", intent: { skillName: "contact" }, suggestionSourceMessageId: SOURCE_MESSAGE_ID, suggestionId: "agree" },
      { method: "suggestion_click", suggestionSourceMessageId: SOURCE_MESSAGE_ID, suggestionId: "" },
      { method: "suggestion_click", suggestionSourceMessageId: SOURCE_MESSAGE_ID, suggestionId: "x".repeat(201) },
      { method: "suggestion_click", suggestionSourceMessageId: SOURCE_MESSAGE_ID, suggestionId: 7 },
    ];
    for (const value of rejected) {
      expect(chatInputMetadataSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
      expect(strictChatInputMetadataSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
    }
  });

  it("reads the chip id back from a stored message, and drops one that is not well formed", () => {
    expect(parseStoredInputMetadata({ method: "suggestion_click", suggestionSourceMessageId: SOURCE_MESSAGE_ID, suggestionId: "decline" }))
      .toMatchObject({ method: "suggestion_click", suggestionSourceMessageId: SOURCE_MESSAGE_ID, suggestionId: "decline" });
    expect(parseStoredInputMetadata({ method: "suggestion_click", suggestionSourceMessageId: SOURCE_MESSAGE_ID, suggestionId: 3 })?.suggestionId)
      .toBeUndefined();
  });
});
