import { describe, expect, it } from "vitest";

import { clipAtGraphemeBoundary } from "../../src/shared/text/clipAtGraphemeBoundary.js";

describe("clipAtGraphemeBoundary", () => {
  it("keeps text that already fits", () => {
    expect(clipAtGraphemeBoundary("Where is my order?", 200)).toBe("Where is my order?");
  });

  it("cuts to the longest prefix of whole characters within the length", () => {
    expect(clipAtGraphemeBoundary("abcdef", 4)).toBe("abcd");
  });

  it("never splits a surrogate pair", () => {
    expect(clipAtGraphemeBoundary("abc😀", 4)).toBe("abc");
  });

  it("never splits an emoji sequence joined with zero-width joiners", () => {
    expect(clipAtGraphemeBoundary("ab👨‍👩‍👧 family", 6)).toBe("ab");
  });

  it("cuts inside a character only when that one character is longer than the whole limit", () => {
    // A letter carrying 300 combining marks is one character to a reader; an empty label would hide it entirely.
    const stacked = `a${"\u0301".repeat(300)}`;
    expect(clipAtGraphemeBoundary(stacked, 10)).toBe(stacked.slice(0, 10));
    expect(clipAtGraphemeBoundary("😀😀", 1)).toBe("");
  });

  it("never separates a base letter from its combining vowel sign", () => {
    // "कि" is क followed by the vowel sign ि: one character to a reader, two code units.
    expect(clipAtGraphemeBoundary("नमकि", 3)).toBe("नम");
  });
});
