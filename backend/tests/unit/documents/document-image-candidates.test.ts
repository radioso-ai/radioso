import { describe, expect, it } from "vitest";

import { placeDocumentImages } from "../../../src/modules/documents/domain/documentImageCandidates.js";

const CONTENT = [
  "# Alpine Flowers",
  "",
  "The guide walks through every meadow above the tree line.",
  "",
  "Gentians on the ridge above the village",
  "",
  "Edelweiss grows on limestone ledges.",
].join("\n");

const offsetAfter = (text: string, passage: string): number => text.indexOf(passage) + passage.length;

describe("placeDocumentImages", () => {
  it("keeps metadata images first, then inline ones, each address once, numbered in that order", () => {
    const placed = placeDocumentImages({
      content: CONTENT,
      storedText: CONTENT,
      candidates: [
        { sourceUrl: "https://cdn.shop.example/ridge.jpg", role: "inline", alt: "Gentians", textOffset: offsetAfter(CONTENT, "tree line.") },
        { sourceUrl: "https://cdn.shop.example/cover.jpg", role: "primary" },
        { sourceUrl: "https://cdn.shop.example/ridge.jpg", role: "inline", alt: "Again", textOffset: 0 },
      ],
    });

    expect(placed).toEqual([
      { sourceUrl: "https://cdn.shop.example/cover.jpg", role: "primary", alt: "", caption: null, position: 0, textOffset: null },
      { sourceUrl: "https://cdn.shop.example/ridge.jpg", role: "inline", alt: "Gentians", caption: null, position: 1, textOffset: offsetAfter(CONTENT, "tree line.") },
    ]);
  });

  it("drops an address that is not absolute http(s), too long, or an SVG file", () => {
    const placed = placeDocumentImages({
      content: CONTENT,
      storedText: CONTENT,
      candidates: [
        { sourceUrl: "/relative.jpg", role: "primary" },
        { sourceUrl: "data:image/png;base64,AAAA", role: "primary" },
        { sourceUrl: "ftp://files.shop.example/a.jpg", role: "primary" },
        { sourceUrl: `https://cdn.shop.example/${"a".repeat(2100)}.jpg`, role: "primary" },
        { sourceUrl: "https://cdn.shop.example/logo.SVG", role: "inline", textOffset: 0 },
        { sourceUrl: "https://cdn.shop.example/kept.jpg", role: "primary" },
      ],
    });

    expect(placed.map((image) => image.sourceUrl)).toEqual(["https://cdn.shop.example/kept.jpg"]);
  });

  it("keeps alt text and caption on one line, without control characters, and within bounds", () => {
    const [image] = placeDocumentImages({
      content: CONTENT,
      storedText: CONTENT,
      candidates: [{
        sourceUrl: "https://cdn.shop.example/ridge.jpg",
        role: "inline",
        alt: "  Gentians\u0000 in\nbloom  ",
        caption: "x".repeat(800),
        textOffset: 0,
      }],
    });

    expect(image?.alt).toBe("Gentians in bloom");
    expect(image?.caption).toHaveLength(500);
  });

  it("caps metadata images at three and inline images at twenty-four", () => {
    const placed = placeDocumentImages({
      content: CONTENT,
      storedText: CONTENT,
      candidates: [
        ...Array.from({ length: 5 }, (_value, index) => ({ sourceUrl: `https://cdn.shop.example/p${index}.jpg`, role: "primary" as const })),
        ...Array.from({ length: 30 }, (_value, index) => ({ sourceUrl: `https://cdn.shop.example/i${index}.jpg`, role: "inline" as const, textOffset: 0 })),
      ],
    });

    expect(placed.filter((image) => image.role === "primary")).toHaveLength(3);
    expect(placed.filter((image) => image.role === "inline")).toHaveLength(24);
  });

  it("moves an inline image's offset to where the same text sits in the stored document", () => {
    const stored = `Alpine Flowers\n\nThe guide walks through every meadow above the tree line.\n\nGentians on the ridge above the village\n\nEdelweiss grows on limestone ledges.`;

    const [image] = placeDocumentImages({
      content: CONTENT,
      storedText: stored,
      candidates: [{ sourceUrl: "https://cdn.shop.example/ridge.jpg", role: "inline", textOffset: offsetAfter(CONTENT, "tree line.") }],
    });

    expect(stored.slice(0, image?.textOffset ?? 0)).toMatch(/tree line\.$/);
  });

  it("leaves an inline image unplaced when its text is not in the stored document, and gives a primary image no offset", () => {
    const placed = placeDocumentImages({
      content: CONTENT,
      storedText: "Something else entirely, cropped by the sanitiser.",
      candidates: [
        { sourceUrl: "https://cdn.shop.example/ridge.jpg", role: "inline", textOffset: offsetAfter(CONTENT, "tree line.") },
        { sourceUrl: "https://cdn.shop.example/cover.jpg", role: "primary", textOffset: 12 },
        { sourceUrl: "https://cdn.shop.example/nowhere.jpg", role: "inline", textOffset: -4 },
      ],
    });

    expect(placed.map((image) => [image.sourceUrl, image.textOffset])).toEqual([
      ["https://cdn.shop.example/cover.jpg", null],
      ["https://cdn.shop.example/ridge.jpg", null],
      ["https://cdn.shop.example/nowhere.jpg", null],
    ]);
  });

  it("places an image at the start of the text at offset zero", () => {
    const [image] = placeDocumentImages({
      content: CONTENT,
      storedText: CONTENT,
      candidates: [{ sourceUrl: "https://cdn.shop.example/ridge.jpg", role: "inline", textOffset: 0 }],
    });

    expect(image?.textOffset).toBe(0);
  });
});
