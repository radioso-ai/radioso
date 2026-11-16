import { describe, expect, it } from "vitest";

import type { UserMessageInputMetadata } from "../../src/shared/domain/chatInputMetadata.js";
import { visibleMessageText } from "../../src/shared/domain/visibleMessageText.js";

const IMAGE_ID = "6c3e9f2a-1d4b-4b8e-9f0a-2a4c6e8b0d12";
const READING = "A landscape photo of rolling countryside.";

describe("visibleMessageText", () => {
  it("reads a message without photos as its content", () => {
    expect(visibleMessageText({ content: "What are your shop hours?" })).toEqual({ text: "What are your shop hours?", photoCount: 0 });
    const typed: UserMessageInputMetadata = { method: "typed" };
    expect(visibleMessageText({ content: "Hello", inputMetadata: typed })).toEqual({ text: "Hello", photoCount: 0 });
    expect(visibleMessageText({ content: "Hello", inputMetadata: null })).toEqual({ text: "Hello", photoCount: 0 });
  });

  it("reads a message with photos as what the visitor typed and how many photos came with it, never the readings", () => {
    const message = {
      content: `Something like this, please\n<attached_photo index="1">${READING}</attached_photo>\n<attached_photo index="2" status="unreadable"/>`,
      inputMetadata: {
        method: "typed" as const,
        imageInput: { typedText: "Something like this, please", images: [{ id: IMAGE_ID, reading: READING }, { id: IMAGE_ID, reading: null }] },
      },
    };

    expect(visibleMessageText(message)).toEqual({ text: "Something like this, please", photoCount: 2 });
  });

  it("reads a photo-only message as no text and its photos", () => {
    expect(visibleMessageText({
      content: `<attached_photo index="1">${READING}</attached_photo>`,
      inputMetadata: { method: "typed", imageInput: { typedText: "", images: [{ id: IMAGE_ID, reading: READING }] } },
    })).toEqual({ text: "", photoCount: 1 });
  });

  it("takes the visitor's typed text as written, even when it quotes the turn markup", () => {
    expect(visibleMessageText({
      content: "why does <attached_photo> show up?\n<attached_photo index=\"1\">x</attached_photo>",
      inputMetadata: { method: "typed", imageInput: { typedText: "why does <attached_photo> show up?", images: [{ id: IMAGE_ID, reading: "x" }] } },
    }).text).toBe("why does <attached_photo> show up?");
  });

  it("never reads the turn text for markup, so a message with no stored photos keeps its content whole", () => {
    const content = `look <attached_photo index="1">${READING}</attached_photo>`;

    expect(visibleMessageText({ content })).toEqual({ text: content, photoCount: 0 });
  });
});
