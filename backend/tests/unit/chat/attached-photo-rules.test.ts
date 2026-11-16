import { describe, expect, it } from "vitest";

import type { MessageRecord } from "../../../src/db/repositories/messageRepository.js";
import { attachedPhotoRules, turnCarriesPhotos } from "../../../src/modules/chat/services/attachedPhotoRules.js";
import { renderVisitorImageTurn } from "../../../src/modules/visitorImages/public.js";

const message = (overrides: Partial<MessageRecord>): Pick<MessageRecord, "content" | "inputMetadata"> => ({
  content: "Are there any similar courses?",
  ...overrides,
});

describe("turnCarriesPhotos", () => {
  it("reads the photos the stored message records", () => {
    expect(turnCarriesPhotos(message({
      inputMetadata: {
        method: "typed",
        imageInput: { typedText: "like this?", images: [{ id: "5b0f2d4e-8a3c-4e1f-9b6d-2c7a1e3f4d50", reading: null }] },
      },
    }))).toBe(true);
  });

  it("reads the photo blocks in the turn text when the message comes without its metadata, as an eval or a replay sends it", () => {
    expect(turnCarriesPhotos(message({ content: renderVisitorImageTurn("like this?", [{ reading: "A stone farmhouse." }]) }))).toBe(true);
  });

  it("is false for a message with no photo", () => {
    expect(turnCarriesPhotos(message({ inputMetadata: { method: "typed" } }))).toBe(false);
  });
});

describe("attachedPhotoRules", () => {
  it("explains the blocks once, with the second part of the reply each path writes", () => {
    const grounded = attachedPhotoRules("grounded");
    const decline = attachedPhotoRules("decline");
    const reply = attachedPhotoRules("reply");

    for (const rules of [grounded, decline, reply]) {
      expect(rules).toMatch(/^Attached photos\n/);
      expect(rules).toContain('<attached_photo index="n" status="unreadable"/>');
      expect(rules).not.toContain("{{");
    }
    expect(new Set([grounded, decline, reply]).size).toBe(3);
    // Only the grounded answer commits a verdict and an outcome.
    expect(grounded).toContain("`no_support`");
    expect(decline).not.toContain("`no_support`");
    expect(reply).not.toContain("`no_support`");
  });
});
