import { describe, expect, it } from "vitest";

import {
  PRESENT_FIELD,
  presentHeadSchemaExtension,
  readPresentHead,
} from "../../../../src/modules/chat/services/replyBlocks/presentHead.js";

describe("present head", () => {
  it("is a strict head field written before the answer, the same on every turn", () => {
    const extension = presentHeadSchemaExtension();

    expect(extension.properties).toEqual({});
    expect(extension.required).toEqual([]);
    expect(extension.beforeAnswer?.required).toEqual([PRESENT_FIELD]);
    expect(presentHeadSchemaExtension()).toStrictEqual(extension);

    const present = extension.beforeAnswer?.properties[PRESENT_FIELD] as {
      type: string;
      additionalProperties: boolean;
      required: string[];
      properties: Record<string, { type: string; items?: Record<string, unknown>; maxLength?: number }>;
    };
    expect(present.type).toBe("object");
    expect(present.additionalProperties).toBe(false);
    expect(present.required).toEqual(Object.keys(present.properties));
    expect(Object.keys(present.properties)).toEqual(["images", "caption", "selection"]);
    expect(present.properties.images?.items?.type).toBe("string");
    expect(present.properties.images?.items).not.toHaveProperty("enum");
    expect(present.properties.caption?.maxLength).toBe(120);
    expect(present.properties.selection).toMatchObject({ type: "string", enum: ["none", "single"] });
  });

  it("reads the images, caption and selection the model returned", () => {
    expect(readPresentHead({ [PRESENT_FIELD]: { images: ["m2", " [m1] "], caption: "  Hiking guides  ", selection: "single" } })).toEqual({
      images: ["m2", " [m1] "],
      caption: "Hiking guides",
      selection: "single",
    });
  });

  it("reads a missing or unknown selection as none, so the cards are only shown", () => {
    for (const selection of [undefined, "many", 1]) {
      expect(readPresentHead({ [PRESENT_FIELD]: { images: ["m1"], caption: "Guides", selection } })?.selection).toBe("none");
    }
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
