import { describe, expect, it } from "vitest";

import { mapUserMessageInputMetadata } from "../../src/db/repositories/messageInputMetadata.js";

const IMAGE_ID = "6c3e9f2a-1d4b-4b8e-9f0a-2a4c6e8b0d12";

describe("mapUserMessageInputMetadata", () => {
  it("reads a message's photos: what the visitor typed, and each photo with its reading", () => {
    expect(mapUserMessageInputMetadata({
      method: "typed",
      imageInput: { typedText: "Something like this", images: [{ id: IMAGE_ID, reading: "A stone farmhouse." }, { id: IMAGE_ID, reading: null }] },
    })).toEqual({
      method: "typed",
      imageInput: { typedText: "Something like this", images: [{ id: IMAGE_ID, reading: "A stone farmhouse." }, { id: IMAGE_ID, reading: null }] },
    });
  });

  it("drops a malformed photo record rather than the whole metadata", () => {
    expect(mapUserMessageInputMetadata({ method: "typed", imageInput: { typedText: 4, images: [] } })).toEqual({ method: "typed" });
    expect(mapUserMessageInputMetadata({ method: "typed", imageInput: { typedText: "", images: [{ id: "not-a-uuid", reading: null }] } })).toEqual({ method: "typed" });
  });

  it("keeps reading the fields it read before", () => {
    expect(mapUserMessageInputMetadata({
      method: "intent_click",
      intent: { skillName: "contact", intentName: "call" },
      sensitiveSlotKeys: ["phone"],
    })).toEqual({ method: "intent_click", intent: { skillName: "contact", intentName: "call" } });
    expect(mapUserMessageInputMetadata({ method: "nope" })).toBeUndefined();
    expect(mapUserMessageInputMetadata(null)).toBeUndefined();
  });
});
