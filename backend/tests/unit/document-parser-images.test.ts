import { extractDocumentImages, parseDocument, type EmbeddedDocumentImage } from "@radioso/document-parser";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";

import { buildDocx, buildPdf, buildStoredZip, flatRgb } from "../support/documentFileFixtures.js";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const solid = (width: number, height: number, format: "png" | "jpeg") =>
  sharp({ create: { width, height, channels: 3, background: { r: 60, g: 130, b: 90 } } })[format]().toBuffer();

let ridge: Buffer;
let ledge: Buffer;
let meadow: Buffer;

beforeAll(async () => {
  ridge = await solid(800, 600, "png");
  ledge = await solid(640, 480, "jpeg");
  meadow = await solid(400, 300, "jpeg");
});

const embedded = (image: unknown): EmbeddedDocumentImage => {
  expect(image).toMatchObject({ kind: "embedded" });
  return image as EmbeddedDocumentImage;
};

describe("extractDocumentImages: DOCX", () => {
  const twoPictures = () => buildDocx({
    paragraphs: [
      { text: "The guide walks through every meadow above the tree line." },
      { image: { media: "media/image1.png", descr: "Gentians on the ridge", title: "Ridge" } },
      { text: "Figure 1: The ridge above the village in June", styleId: "Caption" },
      { text: "Edelweiss grows on limestone ledges and opens late in the summer." },
      { image: { media: "media/image2.jpeg", title: "Edelweiss on a ledge" } },
      { text: "An index of every species closes the guide." },
    ],
    media: { "media/image1.png": ridge, "media/image2.jpeg": ledge },
    styles: [{ id: "Caption", name: "caption" }],
  });

  it("reads each picture's bytes, alt text and caption, in document order, placed in the text parseDocument returns", async () => {
    const buffer = twoPictures();
    const parsed = await parseDocument({ buffer, filename: "guide.docx", mimeType: DOCX });

    const result = await extractDocumentImages({ buffer, filename: "guide.docx", mimeType: DOCX });

    expect(result.fileType).toBe("docx");
    expect(result.truncated).toBe(false);
    expect(result.text).toBe(parsed.markdown);
    expect(result.images).toHaveLength(2);
    const [first, second] = result.images.map(embedded);
    expect(first?.bytes.equals(ridge)).toBe(true);
    expect(first).toMatchObject({ alt: "Gentians on the ridge", caption: "Figure 1: The ridge above the village in June" });
    expect(second?.bytes.equals(ledge)).toBe(true);
    expect(second).toMatchObject({ alt: "Edelweiss on a ledge", caption: null });
    // Each sits after the paragraph before it and before the one after it.
    expect(result.text.slice(0, first?.textOffset).trimEnd().endsWith("above the tree line.")).toBe(true);
    expect(result.text.slice(first?.textOffset).trimStart().startsWith("Figure 1")).toBe(true);
    expect(result.text.slice(0, second?.textOffset).trimEnd().endsWith("late in the summer.")).toBe(true);
  });

  it("knows a caption by Word's caption style, whatever its id, and never by the words in the paragraph", async () => {
    const buffer = buildDocx({
      paragraphs: [
        { image: { media: "media/image1.png", descr: "Ridge" } },
        { text: "Abbildung 1: Der Grat", styleId: "Beschriftung" },
        { image: { media: "media/image2.jpeg", descr: "Ledge" } },
        { text: "Caption: this paragraph only says so" },
      ],
      media: { "media/image1.png": ridge, "media/image2.jpeg": ledge },
      styles: [{ id: "Beschriftung", name: "caption" }],
    });

    const result = await extractDocumentImages({ buffer, filename: "guide.docx", mimeType: DOCX });

    expect(result.images.map((image) => image.caption)).toEqual(["Abbildung 1: Der Grat", null]);
  });

  it("returns a picture used twice once, and stops at the limit it is given", async () => {
    const buffer = buildDocx({
      paragraphs: [
        { image: { media: "media/image1.png" } },
        { image: { media: "media/image1.png" } },
        { image: { media: "media/image2.jpeg" } },
        { image: { media: "media/image3.jpeg" } },
      ],
      media: { "media/image1.png": ridge, "media/image2.jpeg": ledge, "media/image3.jpeg": meadow },
    });

    const result = await extractDocumentImages({ buffer, filename: "guide.docx", mimeType: DOCX, limits: { maxImages: 2 } });

    expect(result.images.map((image) => embedded(image).bytes.length)).toEqual([ridge.length, ledge.length]);
    expect(result.truncated).toBe(true);
  });

  it("refuses an archive past the office limits before reading a picture", async () => {
    const bomb = buildStoredZip({ "word/document.xml": "<w:document/>" });
    // The central directory claims 26 MB for an entry stored in a few bytes.
    const directory = bomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bomb.writeUInt32LE(26 * 1024 * 1024, directory + 24);

    await expect(extractDocumentImages({ buffer: bomb, filename: "bomb.docx", mimeType: DOCX }))
      .rejects.toMatchObject({ code: "archive_too_large", name: "DocumentParserError" });
  });
});

describe("extractDocumentImages: PDF", () => {
  it("decodes a page's image to a PNG anchored where the page's text starts, and leaves a tiny one out", async () => {
    const buffer = buildPdf([
      { text: "Alpine flowers of the high meadows" },
      { text: "Gentians open in June", images: [{ width: 400, height: 300, filter: "DCTDecode", data: meadow }, { width: 12, height: 12, filter: "FlateDecode", data: flatRgb(12, 12) }] },
    ]);
    const parsed = await parseDocument({ buffer, filename: "flowers.pdf", mimeType: "application/pdf" });

    const result = await extractDocumentImages({ buffer, filename: "flowers.pdf", mimeType: "application/pdf", limits: { minShortSidePx: 200 } });

    expect(result.fileType).toBe("pdf");
    expect(result.text).toBe(parsed.markdown);
    expect(result.images).toHaveLength(1);
    const [image] = result.images.map(embedded);
    expect(await sharp(image?.bytes).metadata()).toMatchObject({ format: "png", width: 400, height: 300 });
    expect(image?.textOffset).toBe(result.text.indexOf("Gentians open in June"));
    expect(image).toMatchObject({ alt: "", caption: null });
  });

  it("never decodes an image past the pixel cap, and leaves out stencil masks and malformed streams", async () => {
    const buffer = buildPdf([{
      text: "A page of refused images",
      images: [
        // 400 megapixels declared over a few bytes: a decompression bomb.
        { width: 20_000, height: 20_000, filter: "FlateDecode", data: flatRgb(4, 4) },
        { width: 300, height: 300, imageMask: true, data: Buffer.alloc(Math.ceil(300 / 8) * 300, 0xff) },
        { width: 300, height: 300, filter: "DCTDecode", data: Buffer.from("not a jpeg at all") },
        { width: 300, height: 300, filter: "FlateDecode", data: flatRgb(300, 300) },
      ],
    }]);

    const startedAt = Date.now();
    const result = await extractDocumentImages({ buffer, filename: "refused.pdf", mimeType: "application/pdf", limits: { minShortSidePx: 200 } });

    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(result.images).toHaveLength(1);
    expect(await sharp(embedded(result.images[0]).bytes).metadata()).toMatchObject({ width: 300, height: 300 });
  });

  it("leaves out the scan under an OCR text layer and a logo painted on every page", async () => {
    const logo = { width: 240, height: 240, filter: "FlateDecode" as const, data: flatRgb(240, 240, 30), place: [60, 0, 0, 60, 500, 700] as [number, number, number, number, number, number] };
    const buffer = buildPdf([
      { text: "Scanned contract page", invisibleText: true, images: [{ width: 850, height: 1100, filter: "FlateDecode", data: flatRgb(850, 1100, 240), place: [612, 0, 0, 792, 0, 0] }, logo] },
      { text: "Second page", images: [logo, { width: 400, height: 300, filter: "DCTDecode", data: meadow }] },
      { text: "Third page", images: [logo] },
    ]);

    const result = await extractDocumentImages({ buffer, filename: "scan.pdf", mimeType: "application/pdf", limits: { minShortSidePx: 200 } });

    expect(result.images).toHaveLength(1);
    expect(await sharp(embedded(result.images[0]).bytes).metadata()).toMatchObject({ width: 400, height: 300 });
  });

  it("stops examining images at the count budget", async () => {
    const pages = Array.from({ length: 8 }, (_, index) => ({
      text: `Page ${index + 1}`,
      images: [{ width: 220 + index, height: 220, filter: "FlateDecode" as const, data: flatRgb(220 + index, 220, 10 + index) }],
    }));

    const result = await extractDocumentImages({
      buffer: buildPdf(pages), filename: "heavy.pdf", mimeType: "application/pdf",
      limits: { minShortSidePx: 200, maxImagesExamined: 3 },
    });

    expect(result.images).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  it("stops reading when the time budget is spent, keeping what it read", async () => {
    const pages = Array.from({ length: 8 }, (_, index) => ({
      text: `Page ${index + 1}`,
      images: [{ width: 220 + index, height: 220, filter: "FlateDecode" as const, data: flatRgb(220 + index, 220, 10 + index) }],
    }));
    let clock = 0;
    // Every reading of the clock moves it a second on: the budget runs out a few pages in.
    const now = () => (clock += 1_000);

    const result = await extractDocumentImages({
      buffer: buildPdf(pages), filename: "slow.pdf", mimeType: "application/pdf",
      limits: { minShortSidePx: 200, timeBudgetMs: 12_000, now },
    });

    expect(result.truncated).toBe(true);
    expect(result.images.length).toBeGreaterThan(0);
    expect(result.images.length).toBeLessThan(8);
    const full = await parseDocument({ buffer: buildPdf(pages), filename: "slow.pdf", mimeType: "application/pdf" });
    expect(full.markdown.startsWith(result.text)).toBe(true);
  });
});

describe("extractDocumentImages: markdown and other types", () => {
  it("returns each linked image with its alt text, title and place, and refuses data URIs, relative paths and code", async () => {
    const content = [
      "# Alpine flowers",
      "",
      "Gentians open in June.",
      "",
      '![Gentians on the ridge](https://cdn.example/gentians.jpg "The ridge above the village")',
      "",
      "![Inline](data:image/png;base64,iVBORw0KGgo=) and ![Relative](images/local.png)",
      "",
      "```",
      "![In a fence](https://cdn.example/fenced.jpg)",
      "```",
      "",
      "Use `![In code](https://cdn.example/code.jpg)` to show one, like ![Edelweiss](<https://cdn.example/edelweiss.png>).",
    ].join("\r\n");
    const buffer = Buffer.from(`\uFEFF${content}`);
    const parsed = await parseDocument({ buffer, filename: "flowers.md", mimeType: "text/markdown" });

    const result = await extractDocumentImages({ buffer, filename: "flowers.md", mimeType: "text/markdown" });

    expect(result.text).toBe(parsed.markdown);
    expect(result.images).toEqual([
      { kind: "linked", url: "https://cdn.example/gentians.jpg", alt: "Gentians on the ridge", caption: "The ridge above the village", textOffset: result.text.indexOf("![Gentians") },
      { kind: "linked", url: "https://cdn.example/edelweiss.png", alt: "Edelweiss", caption: null, textOffset: result.text.indexOf("![Edelweiss") },
    ]);
  });

  it("reads a line of unclosed image syntax or backtick runs in linear time", async () => {
    const unclosed = `![${"![\\".repeat(60_000)}`;
    const backticks = Array.from({ length: 3_000 }, (_, index) => "`".repeat(index % 40 + 1)).join(" x ");
    const buffer = Buffer.from(`${unclosed}\n${backticks} ![Ridge](https://cdn.example/ridge.png)`);

    const startedAt = Date.now();
    const result = await extractDocumentImages({ buffer, filename: "hostile.md", mimeType: "text/markdown" });

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(result.images.map((image) => image.kind === "linked" ? image.url : null)).toEqual(["https://cdn.example/ridge.png"]);
  });

  it("stores text normalised exactly as the line-ending, NUL, blank-line and trim rules always have", async () => {
    const previousNormalization = (value: string) =>
      value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\u0000/g, "").replace(/\n{3,}/g, "\n\n").trim();
    const samples = [
      " \u00a0\r\n\r\nTitle\r\r\n\u0000\n\n\nBody\u0000 text\r\n\n\n\n\nEnd\t \u3000",
      "a\r\u0000\nb\n\u0000\n\n\nc\u2028",
      "Grüße 🌼\n\n\n\n😀 \uFEFF",
    ];

    for (const sample of samples) {
      const parsed = await parseDocument({ buffer: Buffer.from(sample), filename: "sample.txt", mimeType: "text/plain" });
      expect(parsed.text).toBe(previousNormalization(sample));
    }
  });

  it("finds no pictures in a type that carries none", async () => {
    const result = await extractDocumentImages({ buffer: Buffer.from("Plain text with ![x](https://cdn.example/x.png)"), filename: "notes.txt", mimeType: "text/plain" });

    expect(result).toEqual({ fileType: "txt", text: "", images: [], truncated: false });
  });
});
