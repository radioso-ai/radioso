import { describe, expect, it } from "vitest";

import { containsValueText, matchableValueTexts } from "../../../src/shared/domain/sensitiveTranscript.js";

describe("matchableValueTexts", () => {
  it("matches strings and list strings of four characters or more, never numbers or yes or no", () => {
    expect(matchableValueTexts(["Ada  Lovelace", ["back pain", "no"], 42, true, "abc"])).toEqual(["Ada Lovelace", "back pain"]);
  });

  it("matches a picked card by its title, the text its pick's message states (#1763)", () => {
    const texts = matchableValueTexts([{ key: "/results/1", title: "Villa Rosa", fields: { id: "h-2" } }]);
    expect(texts).toEqual(["Villa Rosa"]);
    expect(containsValueText("villa rosa", texts)).toBe(true);
  });

  it("matches no other object", () => {
    expect(matchableValueTexts([{ id: "yes", payload: "Sure thing" }])).toEqual([]);
  });
});
