import { describe, expect, it } from "vitest";

import {
  findMarkdownSplitBoundaries,
  resolveSafeSplitOffset,
} from "../../src/shared/text/markdownSplitBoundary.js";

/** Offset of `needle` in `markdown`; fails loudly rather than silently returning -1. */
const at = (markdown: string, needle: string, from = 0): number => {
  const offset = markdown.indexOf(needle, from);
  if (offset < 0) {
    throw new Error(`test fixture does not contain ${JSON.stringify(needle)}`);
  }
  return offset;
};

const after = (markdown: string, needle: string, from = 0): number =>
  at(markdown, needle, from) + needle.length;

/** The spans a citation-anchor caller would mark as non-content. */
const anchorRanges = (markdown: string): Array<{ start: number; end: number }> =>
  [...markdown.matchAll(/\[\[(?:\d+|\?)\]\]/g)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));

describe("resolveSafeSplitOffset", () => {
  describe("offsets that are already safe", () => {
    it("returns a plain-prose offset unchanged and reports no relocation", () => {
      const markdown = "Kriya is a technique we teach in Assisi.";
      const candidate = after(markdown, "technique");

      expect(resolveSafeSplitOffset(markdown, candidate)).toEqual({ offset: candidate });
    });

    it("returns an offset that sits exactly at the start of a construct", () => {
      const markdown = "We teach **Kriya Yoga** in Assisi.";
      const candidate = at(markdown, "**Kriya");

      expect(resolveSafeSplitOffset(markdown, candidate).offset).toBe(candidate);
    });

    it("returns an offset that sits exactly at the end of a construct", () => {
      const markdown = "We teach **Kriya Yoga** in Assisi.";
      const candidate = after(markdown, "**Kriya Yoga**");

      expect(resolveSafeSplitOffset(markdown, candidate).offset).toBe(candidate);
    });

    it("returns the offset unchanged for an empty document", () => {
      expect(resolveSafeSplitOffset("", 0)).toEqual({ offset: 0 });
    });
  });

  describe("clamping", () => {
    it("clamps an offset past the end of the document", () => {
      const markdown = "Kriya is a technique.";

      expect(resolveSafeSplitOffset(markdown, 9_000).offset).toBe(markdown.length);
    });

    it("clamps a negative offset to zero", () => {
      expect(resolveSafeSplitOffset("Kriya is a technique.", -5).offset).toBe(0);
    });

    it("never returns an offset past the end even when a construct is unterminated", () => {
      const markdown = "We teach **Kriya Yoga in Assisi";
      const candidate = at(markdown, "Kriya");

      expect(resolveSafeSplitOffset(markdown, candidate).offset).toBeLessThanOrEqual(markdown.length);
    });
  });

  describe("emphasis and strong", () => {
    it("moves past a strong span opened with **", () => {
      const markdown = "Kriya is **a sacred [[1]] technique**, taught in Assisi.";
      const candidate = at(markdown, "[[1]]");

      expect(resolveSafeSplitOffset(markdown, candidate, anchorRanges(markdown))).toEqual({
        offset: after(markdown, "technique**"),
        relocatedPast: "emphasis",
      });
    });

    it("moves past an emphasis span opened with *", () => {
      const markdown = "Kriya is *a sacred [[1]] technique*, taught in Assisi.";
      const candidate = at(markdown, "[[1]]");

      expect(resolveSafeSplitOffset(markdown, candidate, anchorRanges(markdown)).offset).toBe(
        after(markdown, "technique*"),
      );
    });

    it("moves past an emphasis span opened with _", () => {
      const markdown = "Kriya is _a sacred [[1]] technique_, taught in Assisi.";
      const candidate = at(markdown, "[[1]]");

      expect(resolveSafeSplitOffset(markdown, candidate, anchorRanges(markdown)).offset).toBe(
        after(markdown, "technique_"),
      );
    });

    it("moves past a strong span opened with __", () => {
      const markdown = "Kriya is __a sacred [[1]] technique__, taught in Assisi.";
      const candidate = at(markdown, "[[1]]");

      expect(resolveSafeSplitOffset(markdown, candidate, anchorRanges(markdown)).offset).toBe(
        after(markdown, "technique__"),
      );
    });

    it("moves past the outermost span when emphasis nests", () => {
      const markdown = "Kriya is **a *sacred [[1]] deep* technique**, taught here.";
      const candidate = at(markdown, "[[1]]");

      expect(resolveSafeSplitOffset(markdown, candidate, anchorRanges(markdown)).offset).toBe(
        after(markdown, "technique**"),
      );
    });

    it("does not treat an escaped asterisk as emphasis", () => {
      const markdown = "A literal \\*star and another \\* star, plus text after.";
      const candidate = at(markdown, "and");

      expect(resolveSafeSplitOffset(markdown, candidate).offset).toBe(candidate);
    });

    it("does not treat spaced asterisks as emphasis", () => {
      const markdown = "Compute 2 * 3 * 4 for the total.";
      const candidate = at(markdown, "3");

      expect(resolveSafeSplitOffset(markdown, candidate).offset).toBe(candidate);
    });

    it("does not treat intraword underscores as emphasis", () => {
      const markdown = "Set snake_case_name and other_value in the config.";
      const candidate = at(markdown, "and");

      expect(resolveSafeSplitOffset(markdown, candidate).offset).toBe(candidate);
    });

    it("does not carry an unclosed emphasis run across a paragraph break", () => {
      const markdown = "A lone * star here.\n\nA later paragraph with more text.";
      const candidate = at(markdown, "later");

      expect(resolveSafeSplitOffset(markdown, candidate).offset).toBe(candidate);
    });
  });

  describe("code", () => {
    it("moves past an inline code span", () => {
      const markdown = "Run `pnpm [[1]] test` to check the build.";
      const candidate = at(markdown, "[[1]]");

      expect(resolveSafeSplitOffset(markdown, candidate, anchorRanges(markdown))).toEqual({
        offset: after(markdown, "test`"),
        relocatedPast: "code_span",
      });
    });

    it("moves past a multi-backtick code span that contains a single backtick", () => {
      const markdown = "Use ``a ` b [[1]] c`` in the template.";
      const candidate = at(markdown, "[[1]]");

      expect(resolveSafeSplitOffset(markdown, candidate, anchorRanges(markdown)).offset).toBe(
        after(markdown, "c``"),
      );
    });

    it("moves past a backtick-fenced code block", () => {
      const markdown = "Before.\n\n```ts\nconst a = 1; [[1]]\nconst b = 2;\n```\n\nAfter.";
      const candidate = at(markdown, "[[1]]");

      expect(resolveSafeSplitOffset(markdown, candidate, anchorRanges(markdown))).toEqual({
        offset: after(markdown, "\n```", at(markdown, "const b")),
        relocatedPast: "code_fence",
      });
    });

    it("moves past a tilde-fenced code block", () => {
      const markdown = "Before.\n\n~~~\nconst a = 1; [[1]]\nconst b = 2;\n~~~\n\nAfter.";
      const candidate = at(markdown, "[[1]]");

      expect(resolveSafeSplitOffset(markdown, candidate, anchorRanges(markdown)).offset).toBe(
        after(markdown, "\n~~~", at(markdown, "const b")),
      );
    });

    it("does not treat emphasis markers inside a fenced block as emphasis", () => {
      const markdown = "Before.\n\n```\na * b and c * d\n```\n\nAfter [[1]] the block.";
      const candidate = at(markdown, "[[1]]");

      expect(resolveSafeSplitOffset(markdown, candidate, anchorRanges(markdown)).offset).toBe(
        candidate,
      );
    });
  });

  describe("links, images, and autolinks", () => {
    it("moves past an inline link", () => {
      const markdown = "See [the courses [[1]] calendar](https://x.test/c) for dates.";
      const candidate = at(markdown, "[[1]]");

      expect(resolveSafeSplitOffset(markdown, candidate, anchorRanges(markdown))).toEqual({
        offset: after(markdown, "(https://x.test/c)"),
        relocatedPast: "link",
      });
    });

    it("moves past an inline link whose destination contains parentheses", () => {
      const markdown = "See [the [[1]] calendar](https://x.test/c_(2026)) for dates.";
      const candidate = at(markdown, "[[1]]");

      expect(resolveSafeSplitOffset(markdown, candidate, anchorRanges(markdown)).offset).toBe(
        after(markdown, "(https://x.test/c_(2026))"),
      );
    });

    it("moves past an image, including its leading bang", () => {
      const markdown = "Here ![the [[1]] diagram](https://x.test/i.png) shows it.";
      const candidate = at(markdown, "[[1]]");

      expect(resolveSafeSplitOffset(markdown, candidate, anchorRanges(markdown))).toEqual({
        offset: after(markdown, "(https://x.test/i.png)"),
        relocatedPast: "image",
      });
    });

    it("moves past a reference link", () => {
      const markdown = "See [the [[1]] guide][guide-ref] for details.";
      const candidate = at(markdown, "[[1]]");

      expect(resolveSafeSplitOffset(markdown, candidate, anchorRanges(markdown)).offset).toBe(
        after(markdown, "[guide-ref]"),
      );
    });

    it("moves past a collapsed reference link", () => {
      const markdown = "See [the [[1]] guide][] for details.";
      const candidate = at(markdown, "[[1]]");

      expect(resolveSafeSplitOffset(markdown, candidate, anchorRanges(markdown)).offset).toBe(
        after(markdown, "guide][]"),
      );
    });

    it("moves past an autolink", () => {
      const markdown = "Visit <https://x.test/a[[1]]b> for details.";
      const candidate = at(markdown, "[[1]]");

      expect(resolveSafeSplitOffset(markdown, candidate, anchorRanges(markdown))).toEqual({
        offset: after(markdown, "b>"),
        relocatedPast: "autolink",
      });
    });

    it("moves past the enclosing emphasis when a link sits inside it", () => {
      const markdown = "Read **the [course [[1]] page](https://x.test/c) today** for dates.";
      const candidate = at(markdown, "[[1]]");

      expect(resolveSafeSplitOffset(markdown, candidate, anchorRanges(markdown))).toEqual({
        offset: after(markdown, "today**"),
        relocatedPast: "emphasis",
      });
    });

    it("leaves a bare bracketed span that is not a link alone", () => {
      const markdown = "Inspect arr[0] and keep the [2024] label in place.";
      const candidate = at(markdown, "and");

      expect(resolveSafeSplitOffset(markdown, candidate).offset).toBe(candidate);
    });

    it("does not treat an escaped bracket as a link label", () => {
      const markdown = "A literal \\[label\\](not a link) stays put here.";
      const candidate = at(markdown, "stays");

      expect(resolveSafeSplitOffset(markdown, candidate).offset).toBe(candidate);
    });
  });

  describe("tables", () => {
    const table = [
      "Upcoming courses:",
      "",
      "| Course | Date |",
      "| --- | --- |",
      "| Kriya [[1]] | May |",
      "| Yoga | June |",
      "",
      "Book early.",
    ].join("\n");

    it("moves past the entire table block, not just the row", () => {
      const candidate = at(table, "[[1]]");
      const result = resolveSafeSplitOffset(table, candidate, anchorRanges(table));

      expect(result).toEqual({
        offset: after(table, "| Yoga | June |"),
        relocatedPast: "table",
      });
    });

    it("moves past the table when the anchor is in the header row", () => {
      const markdown = table.replace("| Course | Date |", "| Course [[2]] | Date |");
      const candidate = at(markdown, "[[2]]");

      expect(resolveSafeSplitOffset(markdown, candidate, anchorRanges(markdown)).offset).toBe(
        after(markdown, "| Yoga | June |"),
      );
    });

    it("leaves an offset after the table block alone", () => {
      const candidate = at(table, "Book");

      expect(resolveSafeSplitOffset(table, candidate).offset).toBe(candidate);
    });

    it("does not treat a thematic break as a table delimiter row", () => {
      const markdown = "Intro text here.\n\n---\n\nMore text [[1]] after the break.";
      const candidate = at(markdown, "[[1]]");

      expect(resolveSafeSplitOffset(markdown, candidate, anchorRanges(markdown)).offset).toBe(
        candidate,
      );
    });
  });

  describe("ignoredRanges", () => {
    // The resolver must not read a caller-marked non-content span as markdown. Without
    // that signal the anchor's own brackets form a `[label](dest)` shape and swallow the
    // following prose, relocating a split that did not need to move.
    const markdown = "The course[[1]](see [[2]] below) is offered in Assisi.";

    it("does not build a link out of a span the caller marked as non-content", () => {
      const candidate = at(markdown, "[[2]]");

      expect(resolveSafeSplitOffset(markdown, candidate, anchorRanges(markdown)).offset).toBe(
        candidate,
      );
    });

    it("reads the same text as a link when the caller marks nothing", () => {
      const candidate = at(markdown, "[[2]]");

      expect(resolveSafeSplitOffset(markdown, candidate).offset).toBe(after(markdown, "below)"));
    });

    it("still detects a construct that spans an ignored range", () => {
      const spanning = "Kriya is **a sacred [[1]] technique** here.";
      const candidate = at(spanning, "[[1]]");

      expect(resolveSafeSplitOffset(spanning, candidate, anchorRanges(spanning)).offset).toBe(
        after(spanning, "technique**"),
      );
    });

    it("accepts unsorted and overlapping ignored ranges", () => {
      const spanning = "Kriya is **a sacred [[1]] technique** here.";
      const candidate = at(spanning, "[[1]]");
      const unsorted = [
        { start: at(spanning, "[[1]]") + 2, end: at(spanning, "[[1]]") + 5 },
        { start: at(spanning, "[[1]]"), end: at(spanning, "[[1]]") + 3 },
      ];

      expect(resolveSafeSplitOffset(spanning, candidate, unsorted).offset).toBe(
        after(spanning, "technique**"),
      );
    });
  });

  describe("monotonicity", () => {
    it("never returns a smaller offset for a larger candidate", () => {
      const markdown = [
        "Intro **bold with [[1]] anchor** and `code [[2]] span`.",
        "",
        "| A | B |",
        "| --- | --- |",
        "| x [[3]] | y |",
        "",
        "See [the [[4]] guide](https://x.test/g) and plain text [[5]] too.",
      ].join("\n");
      const ignored = anchorRanges(markdown);
      const boundaries = findMarkdownSplitBoundaries(markdown, ignored);

      let previous = -1;
      for (let candidate = 0; candidate <= markdown.length; candidate += 1) {
        const { offset } = boundaries.resolve(candidate);
        expect(offset).toBeGreaterThanOrEqual(candidate);
        expect(offset).toBeGreaterThanOrEqual(previous);
        expect(offset).toBeLessThanOrEqual(markdown.length);
        previous = offset;
      }
    });
  });

  describe("findMarkdownSplitBoundaries", () => {
    it("scans once and answers repeated queries identically to the one-shot helper", () => {
      const markdown = "Kriya is **a sacred [[1]] technique** taught in Assisi.";
      const ignored = anchorRanges(markdown);
      const boundaries = findMarkdownSplitBoundaries(markdown, ignored);
      const candidate = at(markdown, "[[1]]");

      expect(boundaries.resolve(candidate)).toEqual(
        resolveSafeSplitOffset(markdown, candidate, ignored),
      );
      expect(boundaries.resolve(candidate)).toEqual(boundaries.resolve(candidate));
    });
  });
});
