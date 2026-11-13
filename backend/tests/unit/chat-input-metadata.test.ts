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

  it("keeps a click on a chip whose authored id is longer than a chip id it keeps, without the id", () => {
    const click = { method: "suggestion_click", suggestionSourceMessageId: SOURCE_MESSAGE_ID, suggestionId: "x".repeat(201) };

    for (const schema of [chatInputMetadataSchema, strictChatInputMetadataSchema]) {
      expect(schema.parse(click)).toEqual({ method: "suggestion_click", suggestionSourceMessageId: SOURCE_MESSAGE_ID });
    }
    expect(chatInputMetadataSchema.parse({ ...click, suggestionId: "x".repeat(200) })).toEqual({ ...click, suggestionId: "x".repeat(200) });
  });

  it("rejects a chip id on anything but a suggestion click, and one that is blank or not text", () => {
    const rejected = [
      { method: "typed", suggestionId: "agree" },
      { method: "intent_click", intent: { skillName: "contact" }, suggestionSourceMessageId: SOURCE_MESSAGE_ID, suggestionId: "agree" },
      { method: "suggestion_click", suggestionSourceMessageId: SOURCE_MESSAGE_ID, suggestionId: "" },
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

describe("a card picked from a reply (#1763, item_select)", () => {
  const selection = { messageId: SOURCE_MESSAGE_ID, blockId: "b1", itemKey: "/results/2" };

  it("takes the picked card's message, block and key with item_select, on the chat schema only", () => {
    const pick = { method: "item_select", selection };

    expect(chatInputMetadataSchema.parse(pick)).toEqual(pick);
    // The agent turn probe runs without a stored reply to pick from, so it keeps its three methods.
    expect(strictChatInputMetadataSchema.safeParse(pick).success).toBe(false);
  });

  it("rejects item_select without a selection, a selection on another method, and a malformed selection", () => {
    const rejected = [
      { method: "item_select" },
      { method: "typed", selection },
      { method: "suggestion_click", suggestionSourceMessageId: SOURCE_MESSAGE_ID, selection },
      { method: "item_select", selection: { ...selection, messageId: "not-a-uuid" } },
      { method: "item_select", selection: { ...selection, blockId: "" } },
      { method: "item_select", selection: { ...selection, itemKey: "x".repeat(129) } },
      { method: "item_select", selection: { messageId: SOURCE_MESSAGE_ID, blockId: "b1" } },
    ];
    for (const value of rejected) {
      expect(chatInputMetadataSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
    }
  });

  it("reads the selection back from a stored message, and drops one that is not well formed", () => {
    expect(parseStoredInputMetadata({ method: "item_select", selection })).toMatchObject({ method: "item_select", selection });
    expect(parseStoredInputMetadata({ method: "item_select", selection: { messageId: SOURCE_MESSAGE_ID } })?.selection).toBeUndefined();
  });
});
