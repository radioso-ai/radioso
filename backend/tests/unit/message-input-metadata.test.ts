import { describe, expect, it } from "vitest";

import { MAX_IMAGES_PER_MESSAGE, parseStoredInputMetadata } from "../../src/shared/domain/chatInputMetadata.js";
import { VISITOR_IMAGE_LIMITS } from "../../src/modules/visitorImages/public.js";

const IMAGE_ID = "6c3e9f2a-1d4b-4b8e-9f0a-2a4c6e8b0d12";

describe("parseStoredInputMetadata", () => {
  it("reads a message's photos: what the visitor typed, and each photo with its reading", () => {
    expect(parseStoredInputMetadata({
      method: "typed",
      imageInput: { typedText: "Something like this", images: [{ id: IMAGE_ID, reading: "A stone farmhouse." }, { id: IMAGE_ID, reading: null }] },
    })).toEqual({
      method: "typed",
      imageInput: { typedText: "Something like this", images: [{ id: IMAGE_ID, reading: "A stone farmhouse." }, { id: IMAGE_ID, reading: null }] },
    });
  });

  it("holds a stored message to the photo limit the module enforces at upload, one constant for both", () => {
    const image = (index: number) => ({ id: `00000000-0000-4000-8000-00000000000${index}`, reading: null });
    const stored = (count: number) => parseStoredInputMetadata({
      method: "typed",
      imageInput: { typedText: "", images: Array.from({ length: count }, (_, index) => image(index)) },
    })?.imageInput;

    expect(VISITOR_IMAGE_LIMITS.maxImagesPerMessage).toBe(MAX_IMAGES_PER_MESSAGE);
    expect(stored(MAX_IMAGES_PER_MESSAGE)?.images).toHaveLength(MAX_IMAGES_PER_MESSAGE);
    expect(stored(MAX_IMAGES_PER_MESSAGE + 1)).toBeUndefined();
  });

  it("drops a malformed photo record rather than the whole metadata", () => {
    expect(parseStoredInputMetadata({ method: "typed", imageInput: { typedText: 4, images: [] } })).toEqual({ method: "typed" });
    expect(parseStoredInputMetadata({ method: "typed", imageInput: { typedText: "", images: [{ id: "not-a-uuid", reading: null }] } })).toEqual({ method: "typed" });
  });

  it("keeps reading the fields it read before", () => {
    expect(parseStoredInputMetadata({
      method: "intent_click",
      intent: { skillName: "contact", intentName: "call" },
      sensitiveSlotKeys: ["phone"],
    })).toEqual({ method: "intent_click", intent: { skillName: "contact", intentName: "call" } });
    expect(parseStoredInputMetadata({ method: "nope" })).toBeUndefined();
    expect(parseStoredInputMetadata(null)).toBeUndefined();
  });
});
