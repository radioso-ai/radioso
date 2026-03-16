import { describe, expect, it } from "vitest";

import { CitationAnchorParser } from "../../src/modules/chat/services/citationAnchorParser.js";
import { CitationAnchorSanitizer } from "../../src/modules/chat/services/citationAnchorSanitizer.js";

describe("citation anchor parser", () => {
  it("parses [[N]] anchors into exact segments and a citation list", () => {
    const parser = new CitationAnchorParser();

    const result = parser.present({
      answer: "First claim.[[1]] Second claim.[[2]]",
      citations: [
        { documentId: "doc-1", chunkId: "chunk-1", title: "Doc 1", content: "First claim." },
        { documentId: "doc-2", chunkId: "chunk-2", title: "Doc 2", content: "Second claim." },
      ],
    });

    expect(result).toEqual({
      answer: "First claim. Second claim.",
      citations: [
        { documentId: "doc-1", chunkId: "chunk-1", title: "Doc 1" },
        { documentId: "doc-2", chunkId: "chunk-2", title: "Doc 2" },
      ],
      answerSegments: [
        { text: "First claim.", citationIndices: [0] },
        { text: " Second claim.", citationIndices: [1] },
      ],
    });
  });

  it("ignores invalid anchors and removes placeholder syntax from the answer", () => {
    const parser = new CitationAnchorParser();

    const result = parser.present({
      answer: "Invalid cite[[99]] then valid.[[1]] then malformed [[x]]",
      citations: [
        { documentId: "doc-1", chunkId: "chunk-1", title: "Doc 1", content: "valid" },
      ],
    });

    expect(result.answer).toBe("Invalid cite then valid. then malformed");
    expect(result.citations).toEqual([{ documentId: "doc-1", chunkId: "chunk-1", title: "Doc 1" }]);
    expect(result.answerSegments).toEqual([
      { text: "Invalid cite then valid.", citationIndices: [0] },
      { text: " then malformed" },
    ]);
  });

  it("deduplicates multiple cited chunks from the same document into one visible source", () => {
    const parser = new CitationAnchorParser();

    const result = parser.present({
      answer: "Claim one.[[1]] Claim two.[[2]]",
      citations: [
        { documentId: "doc-1", chunkId: "chunk-1", title: "Doc 1", content: "Claim one." },
        { documentId: "doc-1", chunkId: "chunk-2", title: "Doc 1", content: "Claim two." },
      ],
    });

    expect(result.citations).toEqual([{ documentId: "doc-1", chunkId: "chunk-1", title: "Doc 1" }]);
    expect(result.answerSegments).toEqual([
      { text: "Claim one.", citationIndices: [0] },
      { text: " Claim two.", citationIndices: [0] },
    ]);
  });
});

describe("citation anchor sanitizer", () => {
  it("removes anchors even when they are split across streamed chunks", () => {
    const sanitizer = new CitationAnchorSanitizer();

    const out1 = sanitizer.push("Hello [[");
    const out2 = sanitizer.push("12]] world");
    const out3 = sanitizer.flush();

    expect(`${out1}${out2}${out3}`).toBe("Hello  world");
    expect(`${out1}${out2}${out3}`).not.toContain("[[");
    expect(`${out1}${out2}${out3}`).not.toContain("]]");
  });

  it("removes full anchors from a single chunk", () => {
    const sanitizer = new CitationAnchorSanitizer();

    const out = sanitizer.push("A[[1]]B[[2]]C");

    expect(out).toBe("ABC");
    expect(sanitizer.flush()).toBe("");
  });
});

