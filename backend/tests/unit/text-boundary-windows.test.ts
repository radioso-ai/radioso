import { describe, expect, it } from "vitest";

import { FixedWindowChunkingStrategy } from "../../src/modules/retrieval/domain/chunking/fixedWindowChunkingStrategy.js";
import type { ChunkOutput } from "../../src/modules/retrieval/domain/chunking/chunkingStrategy.js";
import { RETRIEVAL_BEHAVIOR } from "../../src/shared/domain/behaviorConfig.js";
import { propertyCorpus } from "../fixtures/document-attributes/propertyCorpus.js";

const chunkFixedWindow = (content: string, size: number, overlap: number): Promise<ChunkOutput[]> =>
  new FixedWindowChunkingStrategy().chunk({
    title: "Boundaries",
    content,
    config: {
      fixedWindowChunkSize: size,
      fixedWindowChunkOverlap: overlap,
      structuredMinChunkSize: 24,
      structuredMaxChunkSize: 220,
    },
  });

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** A cut between two letters or digits splits a word, in any script that spaces its words. */
const splitsAWord = (text: string, offset: number): boolean =>
  offset > 0
  && offset < text.length
  && LETTER_OR_DIGIT.test(text[offset - 1] ?? "")
  && LETTER_OR_DIGIT.test(text[offset] ?? "");

const wordBoundaries = (text: string): Set<number> => {
  const boundaries = new Set<number>([text.length]);
  for (const segment of new Intl.Segmenter(undefined, { granularity: "word" }).segment(text)) {
    boundaries.add(segment.index);
  }
  return boundaries;
};

const expectCoversEveryWord = (text: string, chunks: ChunkOutput[]) => {
  let covered = 0;
  for (const chunk of chunks) {
    expect(text.slice(covered, chunk.startOffset).trim()).toBe("");
    covered = Math.max(covered, chunk.endOffset);
  }
  expect(text.slice(covered).trim()).toBe("");
};

const expectContentMatchesOffsets = (text: string, chunks: ChunkOutput[]) => {
  for (const chunk of chunks) {
    expect(chunk.content).toBe(text.slice(chunk.startOffset, chunk.endOffset));
  }
};

describe("boundary-aware fixed-window chunking", () => {
  it("never starts or ends a chunk of a Markdown property document in the middle of a word", async () => {
    for (const property of propertyCorpus) {
      const chunks = await chunkFixedWindow(property.markdown, 800, 120);

      expect(chunks.length).toBeGreaterThan(1);
      expectContentMatchesOffsets(property.markdown, chunks);
      expectCoversEveryWord(property.markdown, chunks);
      for (const chunk of chunks) {
        expect(chunk.content.length).toBeLessThanOrEqual(800);
        expect(splitsAWord(property.markdown, chunk.startOffset)).toBe(false);
        expect(splitsAWord(property.markdown, chunk.endOffset)).toBe(false);
      }
    }
  });

  it("ends prose chunks at the end of a sentence when one falls in the window", async () => {
    const sentences = Array.from(
      { length: 40 },
      (_, index) => `Sentence number ${index + 1} describes a quiet courtyard with a well and two lemon trees.`,
    );
    const text = sentences.join(" ");
    const chunks = await chunkFixedWindow(text, 400, 60);

    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.content.endsWith(".")).toBe(true);
      expect(chunk.content.length).toBeLessThanOrEqual(400);
    }
  });

  it("starts each overlapping chunk on a word, inside the previous chunk", async () => {
    const text = propertyCorpus[0].markdown;
    const chunks = await chunkFixedWindow(text, 800, 120);

    for (let index = 1; index < chunks.length; index += 1) {
      const previous = chunks[index - 1];
      const current = chunks[index];
      expect(current.startOffset).toBeLessThan(previous.endOffset);
      expect(previous.endOffset - current.startOffset).toBeLessThanOrEqual(120);
      expect(splitsAWord(text, current.startOffset)).toBe(false);
    }
  });

  it("starts each chunk where the previous one ended when overlap is zero", async () => {
    const text = propertyCorpus[1].markdown;
    const chunks = await chunkFixedWindow(text, 500, 0);

    for (let index = 1; index < chunks.length; index += 1) {
      expect(text.slice(chunks[index - 1].endOffset, chunks[index].startOffset).trim()).toBe("");
    }
    expectCoversEveryWord(text, chunks);
  });

  it("cuts a sentence longer than the window between words", async () => {
    const text = Array.from({ length: 300 }, (_, index) => `stone${index}`).join(" ");
    const chunks = await chunkFixedWindow(text, 200, 30);

    expect(chunks.length).toBeGreaterThan(5);
    expectCoversEveryWord(text, chunks);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(200);
      expect(splitsAWord(text, chunk.startOffset)).toBe(false);
      expect(splitsAWord(text, chunk.endOffset)).toBe(false);
    }
  });

  it("ends chunks of unspaced CJK text at sentence marks, then at word boundaries", async () => {
    const punctuated = "古い石造りの農家は丘の上に立っている。".repeat(30);
    const punctuatedChunks = await chunkFixedWindow(punctuated, 100, 10);

    expect(punctuatedChunks.length).toBeGreaterThan(3);
    for (const chunk of punctuatedChunks.slice(0, -1)) {
      expect(chunk.content.endsWith("。")).toBe(true);
      expect(chunk.content.length).toBeLessThanOrEqual(100);
    }

    const unpunctuated = "東京都内の古い倉庫は撮影に使われる".repeat(20);
    const boundaries = wordBoundaries(unpunctuated);
    const unpunctuatedChunks = await chunkFixedWindow(unpunctuated, 60, 0);

    expect(unpunctuatedChunks.length).toBeGreaterThan(3);
    expectCoversEveryWord(unpunctuated, unpunctuatedChunks);
    for (const chunk of unpunctuatedChunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(60);
      expect(boundaries.has(chunk.startOffset)).toBe(true);
      expect(boundaries.has(chunk.endOffset)).toBe(true);
    }
  });

  it("hard-cuts a single token longer than the window without splitting a character", async () => {
    const token = "😀".repeat(150);
    const chunks = await chunkFixedWindow(token, 101, 0);

    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.map((chunk) => chunk.content).join("")).toBe(token);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(101);
      expect(LONE_SURROGATE.test(chunk.content)).toBe(false);
    }
  });

  it("keeps list items and table rows whole", async () => {
    const list = Array.from({ length: 30 }, (_, index) => `- Room ${index + 1}: chestnut beams, tiled floor, one window`).join("\n");
    const table = [
      "| Room | Floor | Light |",
      "| --- | --- | --- |",
      ...Array.from({ length: 30 }, (_, index) => `| Room ${index + 1} | terracotta tiles | north window |`),
    ].join("\n");

    for (const text of [list, table]) {
      const chunks = await chunkFixedWindow(text, 300, 40);
      expect(chunks.length).toBeGreaterThan(2);
      expectCoversEveryWord(text, chunks);
      for (const chunk of chunks) {
        expect(chunk.content.length).toBeLessThanOrEqual(300);
        expect(chunk.endOffset === text.length || text[chunk.endOffset] === "\n").toBe(true);
      }
    }
  });

  it("keeps a heading with the section it introduces", async () => {
    const paragraph = "The hall has cast-iron columns and wooden floors worn by decades of looms. ";
    const text = `${paragraph.repeat(5).trim()}\n\n## Dye house\n\n${paragraph.repeat(5).trim()}`;
    const chunks = await chunkFixedWindow(text, 420, 0);

    for (const chunk of chunks) {
      const lastLine = chunk.content.trimEnd().split("\n").at(-1) ?? "";
      expect(lastLine.startsWith("#")).toBe(false);
    }
    expect(chunks.some((chunk) => chunk.content.startsWith("## Dye house"))).toBe(true);
  });

  it("keeps every chunk within the configured size from the smallest to the largest setting", async () => {
    const text = propertyCorpus.map((property) => property.markdown).join("\n\n").repeat(3);
    const { fixedWindowChunkSizeMin, fixedWindowChunkSizeMax } = RETRIEVAL_BEHAVIOR.chunking;

    for (const [size, overlap] of [[fixedWindowChunkSizeMin, 0], [fixedWindowChunkSizeMin, 99], [800, 120], [fixedWindowChunkSizeMax, 2_000]] as const) {
      const chunks = await chunkFixedWindow(text, size, overlap);
      expectContentMatchesOffsets(text, chunks);
      expectCoversEveryWord(text, chunks);
      for (const chunk of chunks) {
        expect(chunk.content.length).toBeLessThanOrEqual(size);
      }
    }
  });

  it("splits a large document with no line breaks, or one huge token, without rescanning from its start", async () => {
    const sentence = "The hall has cast-iron columns and wooden floors worn by decades of looms. ";
    const singleLine = sentence.repeat(Math.ceil(2_000_000 / sentence.length));
    const token = "x".repeat(500_000);

    for (const text of [singleLine, token]) {
      const started = performance.now();
      const chunks = await chunkFixedWindow(text, 800, 120);
      // Linear work takes well under a second here; rescanning the text per window took about ten.
      expect(performance.now() - started).toBeLessThan(3_000);
      expect(chunks.length).toBeGreaterThan(600);
    }
  });

  it("returns one chunk for content shorter than the window", async () => {
    const chunks = await chunkFixedWindow("  A single short line.  ", 800, 120);

    expect(chunks).toEqual([{ chunkIndex: 0, content: "A single short line.", startOffset: 0, endOffset: 20 }]);
  });
});
