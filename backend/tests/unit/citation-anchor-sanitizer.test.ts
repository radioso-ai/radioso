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

  it("reflows an orphaned period when an anchor was streamed on its own line", () => {
    const sanitizer = new CitationAnchorSanitizer();

    const chunks = [
      sanitizer.push("It is a science when practiced consistently\n\n[[1]]"),
      sanitizer.push(".\n\nAnanda Europe teaches Kriya."),
      sanitizer.flush(),
    ];

    expect(chunks.join("")).toBe(
      "It is a science when practiced consistently.\n\nAnanda Europe teaches Kriya.",
    );
  });

  it("reattaches a semicolon-led link list streamed after a standalone anchor", () => {
    const sanitizer = new CitationAnchorSanitizer();

    const chunks = [
      sanitizer.push("See our course pages for details\n\n[[1]]"),
      sanitizer.push(" ; [Kriya Yoga intro and practice](https://example.com/intro)."),
      sanitizer.flush(),
    ];

    expect(chunks.join("")).toBe(
      "See our course pages for details; [Kriya Yoga intro and practice](https://example.com/intro).",
    );
  });

  it("preserves a genuine paragraph break that is not adjacent to punctuation", () => {
    const sanitizer = new CitationAnchorSanitizer();

    const chunks = [
      sanitizer.push("First grounded paragraph[[1]].\n\n"),
      sanitizer.push("Second grounded paragraph."),
      sanitizer.flush(),
    ];

    expect(chunks.join("")).toBe(
      "First grounded paragraph.\n\nSecond grounded paragraph.",
    );
  });

  it("preserves natural single-bracket numeric text in streamed output", () => {
    const sanitizer = new CitationAnchorSanitizer();

    const chunks = [
      sanitizer.push("Read [1](https://example.com), inspect arr[0],"),
      sanitizer.push(" and keep the [2024] label."),
      sanitizer.flush(),
    ];

    expect(chunks.join("")).toBe(
      "Read [1](https://example.com), inspect arr[0], and keep the [2024] label.",
    );
  });
});
