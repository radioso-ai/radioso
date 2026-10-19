import { describe, expect, it } from "vitest";

import { CitationAnchorSanitizer } from "../../src/modules/chat/services/citationAnchorSanitizer.js";

describe("citation anchor sanitizer", () => {
  it("never leaks sourced or unsourced anchors split at any boundary", () => {
    for (const marker of ["[[12]]", "[[?]]"]) {
      for (let split = 1; split < marker.length; split += 1) {
        const sanitizer = new CitationAnchorSanitizer();
        const chunks = [
          sanitizer.push(`Claim${marker.slice(0, split)}`),
          sanitizer.push(`${marker.slice(split)}.`),
          sanitizer.flush(),
        ];

        expect(chunks.join(""), `${marker} split at ${split}`).toBe("Claim.");
      }
    }
  });

  it("never leaks explicit unsourced assertions, including across chunks", () => {
    const sanitizer = new CitationAnchorSanitizer();
    const chunks = [
      sanitizer.push("A supported fact[[1]], but a limitation[["),
      sanitizer.push("?"),
      sanitizer.push("]]."),
      sanitizer.flush(),
    ];

    expect(chunks.join("")).toBe("A supported fact, but a limitation.");
  });
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

  it("collapses a detached anchor whose punctuation arrives in the same chunk", () => {
    const sanitizer = new CitationAnchorSanitizer();

    const chunks = [
      sanitizer.push("It is a science when practiced consistently\n\n[[1]]. Ananda Europe teaches Kriya."),
      sanitizer.flush(),
    ];

    expect(chunks.join("")).toBe(
      "It is a science when practiced consistently. Ananda Europe teaches Kriya.",
    );
  });

  it("leaves line-leading punctuation that no anchor detached intact across chunks", () => {
    const sanitizer = new CitationAnchorSanitizer();

    // No citation anchor is involved, so the line break before `:hover` is real answer
    // content (a CSS selector) and must be preserved, not collapsed.
    const chunks = [
      sanitizer.push("Use this selector:\n\n"),
      sanitizer.push(":hover { color: red; }"),
      sanitizer.flush(),
    ];

    expect(chunks.join("")).toBe("Use this selector:\n\n:hover { color: red; }");
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

  it("preserves a markdown link whose label is a bare number, split across chunks", () => {
    const sanitizer = new CitationAnchorSanitizer();

    const chunks = [
      sanitizer.push("See [1]"),
      sanitizer.push("(https://example.com) for details."),
      sanitizer.flush(),
    ];

    expect(chunks.join("")).toBe("See [1](https://example.com) for details.");
  });

  // #1502: the model sometimes writes the unsupported-claim marker with single brackets.
  // The sanitizer reads `[?]` as `[[?]]`, so a single-bracket marker streams exactly as the
  // double-bracket one does.
  describe("single-bracket unsupported-claim marker", () => {
    const stream = (...chunks: string[]): string => {
      const sanitizer = new CitationAnchorSanitizer();
      return [...chunks.map((chunk) => sanitizer.push(chunk)), sanitizer.flush()].join("");
    };

    it("removes a marker mid-sentence", () => {
      const streamed = stream("Kriya is not [?] documented here.");

      expect(streamed).not.toContain("[?]");
      expect(streamed).not.toContain("[[?]]");
      expect(streamed).toMatch(/^Kriya is not\s+documented here\.$/);
    });

    it("removes a marker at the end of a sentence", () => {
      expect(stream("The fee is waived[?]. Ask us about it.")).toBe("The fee is waived. Ask us about it.");
    });

    it("removes a marker the stream ends on", () => {
      expect(stream("Claim[?]")).toBe("Claim");
    });

    it("never leaks a marker split at any chunk boundary", () => {
      const marker = "[?]";
      for (let split = 1; split < marker.length; split += 1) {
        expect(stream(`Claim${marker.slice(0, split)}`, `${marker.slice(split)}.`), `split at ${split}`).toBe("Claim.");
      }
    });

    it("treats a bracket after the marker as it treats one after [[?]], in one chunk or split", () => {
      const doubleBracket = stream("Claim[[?]]] next");

      expect(stream("Claim[?]] next")).toBe(doubleBracket);
      expect(stream("Claim[?]", "] next")).toBe(doubleBracket);
      expect(doubleBracket).not.toContain("[?");
    });

    it("treats a parenthetical after the marker as it treats one after [[?]], at any chunk boundary", () => {
      const snippet = "[?](url)";
      expect(stream("See [[?]](url) for details.")).toBe("See (url) for details.");
      for (let split = 1; split < snippet.length; split += 1) {
        expect(stream(`See ${snippet.slice(0, split)}`, `${snippet.slice(split)} for details.`), `split at ${split}`)
          .toBe("See (url) for details.");
      }
    });

    it("leaves [?] inside inline code alone, at any chunk boundary", () => {
      for (const text of ["Use `[?]` to match a literal question mark.", "The pattern `/a[?]b/` matches ab."]) {
        expect(stream(text)).toBe(text);
        for (let split = 1; split < text.length; split += 1) {
          expect(stream(text.slice(0, split), text.slice(split)), `${text} split at ${split}`).toBe(text);
        }
      }
    });

    it("reads [?] as a marker once an inline code span closes, and at the next line", () => {
      expect(stream("Run `ls` first[?]. Then `pwd`.")).toBe("Run `ls` first. Then `pwd`.");
      expect(stream("A lone ` backtick.\n", "Claim[?].")).toBe("A lone ` backtick.\nClaim.");
    });
  });

  // #1517: the model sometimes drops the closing `]`, leaving a one-bracket-short anchor
  // (`[[?]`, `[[12]`) instead of the complete `[[?]]`/`[[12]]`. The token must disappear
  // without losing any of the surrounding answer text: the carry cap and flush() must
  // release held text instead of discarding it.
  describe("under-closed citation anchor marker", () => {
    const stream = (...chunks: string[]): string => {
      const sanitizer = new CitationAnchorSanitizer();
      return [...chunks.map((chunk) => sanitizer.push(chunk)), sanitizer.flush()].join("");
    };

    it("removes an under-closed `?` marker without losing the text that follows, in one chunk", () => {
      expect(stream("claim[[?] more words here.")).toBe("claim more words here.");
    });

    it("removes an under-closed digit marker without losing the text that follows, in one chunk", () => {
      expect(stream("claim[[1] this is a long sentence that keeps going")).toBe(
        "claim this is a long sentence that keeps going",
      );
    });

    // The exact chunking #1517 reported: the marker and the text right after it arrive
    // in the first chunk, with a later, complete citation in the next one.
    it("keeps every word around the marker when split exactly as #1517 reported it", () => {
      expect(stream("claim[[?] more words here.", " Next sentence[[2]].")).toBe(
        "claim more words here. Next sentence.",
      );
    });

    it("keeps every word around a digit marker when the confirming chunk arrives long after it", () => {
      expect(stream(
        "claim[[1] this is a long sentence that keeps going",
        " and more.",
      )).toBe("claim this is a long sentence that keeps going and more.");
    });

    it("never leaks a `?` marker split at any chunk boundary, including inside the marker itself", () => {
      const marker = "[[?]";
      for (let split = 1; split < marker.length; split += 1) {
        expect(
          stream(`claim${marker.slice(0, split)}`, `${marker.slice(split)} more words here.`),
          `split at ${split}`,
        ).toBe("claim more words here.");
      }
    });

    it("never leaks a digit marker split at any chunk boundary, including inside the marker itself", () => {
      const marker = "[[12]";
      for (let split = 1; split < marker.length; split += 1) {
        expect(
          stream(`claim${marker.slice(0, split)}`, `${marker.slice(split)} more words here.`),
          `split at ${split}`,
        ).toBe("claim more words here.");
      }
    });

    it("does not confuse an under-closed marker with the complete anchor that follows it", () => {
      expect(stream("claim[[?] more. Next[[2]].")).toBe("claim more. Next.");
    });

    it("never drops trailing text even when it is far longer than the carry cap, in one chunk", () => {
      const tail = "x".repeat(200);
      expect(stream(`claim[[1] ${tail}`)).toBe(`claim ${tail}`);
    });

    it("never drops trailing text longer than the carry cap when it arrives in a later chunk", () => {
      const tail = "y".repeat(200);
      expect(stream("claim[[1]", tail)).toBe(`claim${tail}`);
    });

    it("hides a trailing marker attempt entirely when the stream ends before it resolves", () => {
      expect(stream("claim[[1")).toBe("claim");
      expect(stream("claim[[?")).toBe("claim");
      expect(stream("claim[[1]")).toBe("claim");
      expect(stream("claim[[?]")).toBe("claim");
    });

    it("produces the same result no matter where the chunk boundary falls, for the `?` example", () => {
      const full = "claim[[?] more words here. Next sentence[[2]].";
      const expected = "claim more words here. Next sentence.";
      for (let split = 0; split <= full.length; split += 1) {
        expect(stream(full.slice(0, split), full.slice(split)), `split at ${split}`).toBe(expected);
      }
    });

    it("produces the same result no matter where the chunk boundary falls, for the digit example", () => {
      const full = "claim[[1] this is a long sentence that keeps going and more.";
      const expected = "claim this is a long sentence that keeps going and more.";
      for (let split = 0; split <= full.length; split += 1) {
        expect(stream(full.slice(0, split), full.slice(split)), `split at ${split}`).toBe(expected);
      }
    });
  });
});
