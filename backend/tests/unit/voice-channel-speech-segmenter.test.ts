import { describe, expect, it } from "vitest";

import { splitCompleteSentences } from "../../src/modules/voiceChannel/services/speechSegmenter.js";

describe("voice speech segmenter", () => {
  it("cuts a sentence once whitespace follows its terminator and keeps the punctuation", () => {
    expect(splitCompleteSentences("Hello there. How are")).toEqual({
      sentences: ["Hello there. "],
      remainder: "How are",
    });
  });

  it("holds a terminator back until whitespace proves the sentence ended", () => {
    expect(splitCompleteSentences("It costs 3.")).toEqual({ sentences: [], remainder: "It costs 3." });
    expect(splitCompleteSentences("It costs 3.50 a month")).toEqual({
      sentences: [],
      remainder: "It costs 3.50 a month",
    });
  });

  it("cuts every complete sentence in one buffer and keeps the text verbatim", () => {
    const buffer = "Yes! We open at nine.\nDo you want the address? Sure";
    const { sentences, remainder } = splitCompleteSentences(buffer);

    expect(sentences).toEqual(["Yes! ", "We open at nine.\n", "Do you want the address? "]);
    expect(remainder).toBe("Sure");
    expect([...sentences, remainder].join("")).toBe(buffer);
  });

  it("keeps closing quotes and brackets with the sentence they close", () => {
    expect(splitCompleteSentences("She said \"call us.\" Then")).toEqual({
      sentences: ["She said \"call us.\" "],
      remainder: "Then",
    });
  });

  it("treats runs of terminators and an ellipsis as one boundary", () => {
    expect(splitCompleteSentences("Really?! Wait… Fine")).toEqual({
      sentences: ["Really?! ", "Wait… "],
      remainder: "Fine",
    });
  });

  it("cuts after full-width terminators, which are not followed by spaces", () => {
    expect(splitCompleteSentences("はい。予約しますか？それとも")).toEqual({
      sentences: ["はい。", "予約しますか？"],
      remainder: "それとも",
    });
  });

  it("cuts Arabic and Devanagari sentence endings", () => {
    expect(splitCompleteSentences("مرحبا؟ كيف يمكنني المساعدة")).toEqual({
      sentences: ["مرحبا؟ "],
      remainder: "كيف يمكنني المساعدة",
    });
    expect(splitCompleteSentences("नमस्ते। आप कैसे")).toEqual({
      sentences: ["नमस्ते। "],
      remainder: "आप कैसे",
    });
  });

  it("returns the whole buffer as the remainder when no sentence is complete", () => {
    expect(splitCompleteSentences("")).toEqual({ sentences: [], remainder: "" });
    expect(splitCompleteSentences("Let me check")).toEqual({ sentences: [], remainder: "Let me check" });
  });
});
