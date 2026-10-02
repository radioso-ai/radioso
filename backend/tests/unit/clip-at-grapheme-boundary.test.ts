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

  it("never separates a base letter from its combining vowel sign", () => {
    // "कि" is क followed by the vowel sign ि: one character to a reader, two code units.
    expect(clipAtGraphemeBoundary("नमकि", 3)).toBe("नम");
  });
});
