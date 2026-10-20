import { describe, expect, it } from "vitest";

import { AnswerPresentationService } from "../../src/modules/chat/services/answerPresentationService.js";
import { CitationAnchorSanitizer } from "../../src/modules/chat/services/citationAnchorSanitizer.js";
import { CITATION_ANCHOR_MAX_LENGTH } from "../../src/modules/chat/services/citationAnchorSyntax.js";

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

    // A literal `[[` whose text runs past the anchor-syntax bound without closing can never
    // be anchor syntax, so the finished answer keeps it, brackets and all. The stream holds
    // it only while it could still close within the bound, then releases the whole of it,
    // `[[` included: no part of the sentence is lost, and the two paths agree.
    it("releases a `[[` that never becomes an anchor, brackets included, once it outgrows the anchor bound", () => {
      const chunks = [
        "see [[",
        " this long ordinary sentence that keeps going and going well past thirty-two characters",
        " end.",
      ];
      const sanitizer = new CitationAnchorSanitizer();
      const streamed = [...chunks.map((chunk) => sanitizer.push(chunk)), sanitizer.flush()].join("");

      const whole = new CitationAnchorSanitizer();
      const sanitizedWhole = [whole.push(chunks.join("")), whole.flush()].join("");

      expect(streamed).toBe(sanitizedWhole);
      expect(streamed).toBe(
        "see [[ this long ordinary sentence that keeps going and going well past thirty-two characters end.",
      );
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

  // The invariant behind #1517: however the provider happens to split an answer into
  // chunks, the streamed text, joined, is exactly the finished answer the visitor is left
  // with (`done.answer`, from the presentation service). Every 2-way and 3-way split, and
  // one character per chunk, of a corpus of anchor-syntax shapes. Only the ends are
  // trimmed: the presentation trims the answer, and the stream drops trailing whitespace.
  describe("streams exactly the finished answer, however it is chunked", () => {
    const presented = (text: string): string =>
      new AnswerPresentationService().present({ answer: text, citations: [] }).answer.trim();
    const stream = (chunks: string[]): string => {
      const sanitizer = new CitationAnchorSanitizer();
      return [...chunks.map((chunk) => sanitizer.push(chunk)), sanitizer.flush()].join("").trim();
    };
    const beyondBound = "this bracketed aside runs on well past the sixty-four character anchor bound";
    // A span of exactly the bound, brackets included, and one a character longer.
    const atBound = `[[${"a".repeat(CITATION_ANCHOR_MAX_LENGTH - 4)}]]`;
    const overBound = `[[${"a".repeat(CITATION_ANCHOR_MAX_LENGTH - 3)}]]`;
    const corpus: Array<{ text: string; finished: string }> = [
      // The two round-2 review regressions: a bracketed span that is not a citation.
      { text: "The topic [[12xyz]] was notable.", finished: "The topic  was notable." },
      { text: "See [[Example Page]] for details.", finished: "See  for details." },
      { text: "Read the guide [[Example Page]] .", finished: "Read the guide." },
      // Complete anchors, sourced and unsourced, and a multi-digit result number.
      { text: "Claim[[12]] holds.", finished: "Claim holds." },
      { text: "Claim[[?]] holds.", finished: "Claim holds." },
      { text: "Claim[[123]] holds.", finished: "Claim holds." },
      { text: "Claim[?] holds.", finished: "Claim holds." },
      { text: "A [[1, 3]] grouped claim.", finished: "A  grouped claim." },
      // Under-closed anchors, mid-answer and as the very last thing streamed.
      { text: "Claim[[1] holds.", finished: "Claim holds." },
      { text: "Claim[[?] holds.", finished: "Claim holds." },
      { text: "The answer ends on[[1]", finished: "The answer ends on" },
      { text: "The answer ends on[[?]", finished: "The answer ends on" },
      // An anchor the answer is cut short in.
      { text: "The answer ends on [[", finished: "The answer ends on" },
      { text: "The answer ends on [[12", finished: "The answer ends on" },
      // A literal `[[` is text: past the bound, or never closing, it stays.
      { text: `Up to the bound ${atBound} goes.`, finished: "Up to the bound  goes." },
      { text: `Past the bound ${overBound} stays.`, finished: `Past the bound ${overBound} stays.` },
      { text: `see [[${beyondBound}]] end.`, finished: `see [[${beyondBound}]] end.` },
      { text: `see [[ ${beyondBound} end.`, finished: `see [[ ${beyondBound} end.` },
      { text: "see [[Example Page for details.", finished: "see [[Example Page for details." },
      { text: "Claim[[1]] and a [[ that never closes.", finished: "Claim and a [[ that never closes." },
      // Nested and adjacent brackets.
      { text: "Claim[[1]][[2]] holds.", finished: "Claim holds." },
      { text: "Claim[[[1]] holds.", finished: "Claim[ holds." },
      { text: "Use [[1, 2], [3, 4]] as the matrix.", finished: "Use [[1, 2], [3, 4]] as the matrix." },
      // Anchors detached onto their own line before the closing punctuation.
      { text: "It is a science\n\n[[1]]. Next.", finished: "It is a science. Next." },
      { text: "It is a science\n\n[[1]][[2]]. Next.", finished: "It is a science. Next." },
      { text: "It is a science\n\n[[?]]. Next.", finished: "It is a science. Next." },
      { text: "It is a science\n\n[[1]]\uff09Next.", finished: "It is a science\uff09Next." },
      { text: "First paragraph[[1]].\n\nSecond paragraph.", finished: "First paragraph.\n\nSecond paragraph." },
      // Inline code: a `[[` there is literal like anywhere else, and a backtick ends a span.
      { text: "Use `a[[b` in code[[1]].", finished: "Use `a[[b` in code." },
      { text: "Match `[?]` and `[[x` literally[[1]].", finished: "Match `[?]` and `[[x` literally." },
    ];

    // Seeded, so a failure reproduces: generated strings dense in brackets, markers, digits,
    // spaces, punctuation, and backticks, each streamed under several random chunkings.
    // Line breaks stay out: the detached-anchor reflow is covered by the corpus above. Only
    // whitespace may differ from the finished answer, where the presentation spaces the seam
    // around an anchor its own way.
    it("for generated bracket-dense text", () => {
      let seed = 1517;
      const random = (): number => {
        seed = (seed + 0x6d2b79f5) >>> 0;
        let value = Math.imul(seed ^ (seed >>> 15), seed | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
      };
      const pieces = ["[", "[[", "]", "]]", "?", "1", "12", "a", "b ", " ", ".", ",", "`", "[[1]]", "[?]", "[[?]", "[[12]"];
      const withoutWhitespace = (text: string): string => text.replace(/\s+/g, "");
      for (let sample = 0; sample < 2000; sample += 1) {
        const text = Array.from({ length: 1 + Math.floor(random() * 16) }, () =>
          pieces[Math.floor(random() * pieces.length)]).join("");
        const whole = stream([text]);
        expect(withoutWhitespace(whole), JSON.stringify(text)).toBe(withoutWhitespace(presented(text)));
        for (let chunking = 0; chunking < 3; chunking += 1) {
          const chunks: string[] = [];
          for (let start = 0; start < text.length;) {
            const end = start + 1 + Math.floor(random() * 4);
            chunks.push(text.slice(start, end));
            start = end;
          }
          expect(stream(chunks), JSON.stringify(chunks)).toBe(whole);
        }
      }
    });

    for (const { text, finished } of corpus) {
      it(`for ${JSON.stringify(text)}`, () => {
        expect(presented(text)).toBe(finished);
        expect(stream([...text]), "one character per chunk").toBe(finished);
        for (let first = 0; first <= text.length; first += 1) {
          expect(stream([text.slice(0, first), text.slice(first)]), `split at ${first}`).toBe(finished);
          for (let second = first + 1; second < text.length; second += 1) {
            expect(
              stream([text.slice(0, first), text.slice(first, second), text.slice(second)]),
              `split at ${first} and ${second}`,
            ).toBe(finished);
          }
        }
      });
    }
  });
});
