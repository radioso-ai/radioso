import { describe, expect, it } from "vitest";

import {
  PRESENT_FIELD,
  presentHeadSchemaExtension,
  readPresentHead,
} from "../../../../src/modules/chat/services/replyBlocks/presentHead.js";

describe("present head", () => {
  it("is a strict tail field after the answer, the same on every turn", () => {
    const extension = presentHeadSchemaExtension();

    expect(extension.beforeAnswer).toBeUndefined();
    expect(extension.required).toEqual([PRESENT_FIELD]);
    expect(presentHeadSchemaExtension()).toStrictEqual(extension);

    const present = extension.properties[PRESENT_FIELD] as {
      type: string;
      additionalProperties: boolean;
      required: string[];
      properties: Record<string, { type: string; items?: Record<string, unknown>; maxLength?: number }>;
    };
    expect(present.type).toBe("object");
    expect(present.additionalProperties).toBe(false);
    expect(present.required).toEqual(Object.keys(present.properties));
    expect(Object.keys(present.properties)).toEqual(["images", "caption"]);
    expect(present.properties.images?.items?.type).toBe("string");
    expect(present.properties.images?.items).not.toHaveProperty("enum");
    expect(present.properties.caption?.maxLength).toBe(120);
  });

  it("reads the images and caption the model returned", () => {
    expect(readPresentHead({ [PRESENT_FIELD]: { images: ["m2", " [m1] "], caption: "  Hiking guides  " } })).toEqual({
      images: ["m2", " [m1] "],
      caption: "Hiking guides",
    });
  });

  it("rejects a missing or malformed head", () => {
    expect(readPresentHead(undefined)).toBeNull();
    expect(readPresentHead({})).toBeNull();
    expect(readPresentHead({ [PRESENT_FIELD]: "m1" })).toBeNull();
    expect(readPresentHead({ [PRESENT_FIELD]: { images: "m1", caption: "x" } })).toBeNull();
    expect(readPresentHead({ [PRESENT_FIELD]: { images: [1, 2], caption: "x" } })).toBeNull();
    expect(readPresentHead({ [PRESENT_FIELD]: { images: ["m1"] } })).toBeNull();
  });
});
