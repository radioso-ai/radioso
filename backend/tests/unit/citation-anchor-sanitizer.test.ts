import { describe, expect, it } from "vitest";

import { CitationAnchorSanitizer } from "../../src/modules/chat/services/citationAnchorSanitizer.js";

describe("citation anchor sanitizer", () => {
  it("does not stream detached punctuation when an anchor is followed by a spaced period", () => {
    const sanitizer = new CitationAnchorSanitizer();

    const chunks = [
      sanitizer.push("Ananda Yoga can lead naturally into meditation [[1]]"),
      sanitizer.push(" . It also supports inner silence [[1]]"),
      sanitizer.push(" ."),
      sanitizer.flush(),
    ];

    expect(chunks.join("")).toBe(
      "Ananda Yoga can lead naturally into meditation. It also supports inner silence.",
    );
  });
});
