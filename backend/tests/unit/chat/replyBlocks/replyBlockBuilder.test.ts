import { describe, expect, it } from "vitest";

import type { EvidenceImage, EvidenceItemImages } from "../../../../src/modules/retrieval/public.js";
import { TurnImageLedger } from "../../../../src/modules/chat/services/replyBlocks/turnImageLedger.js";
import {
  buildReplyBlock,
  presentReplyBlocks,
} from "../../../../src/modules/chat/services/replyBlocks/replyBlockBuilder.js";
import type { ReplyImageUrls } from "../../../../src/modules/chat/contracts/replyBlocks.js";

const image = (imageId: string, overrides: Partial<EvidenceImage> = {}): EvidenceImage => ({
  imageId,
  role: "primary",
  alt: "",
  caption: null,
  width: 1280,
  height: 960,
  sha256: `sha-${imageId}`,
  ...overrides,
});

const product = (resultNumber: number): EvidenceItemImages => ({
  resultNumber,
  documentId: `doc-${resultNumber}`,
  documentTitle: `Field Guide ${resultNumber}`,
  sourceUrl: `https://shop.example/books/guide-${resultNumber}`,
  images: [image(`cover-${resultNumber}`)],
});

const carouselAndGrid = ["carousel", "grid"] as const;

const urls: ReplyImageUrls = {
  forImage: (imageId) => ({
    src: `https://app.example/images/${imageId}/640`,
    srcSet: `https://app.example/images/${imageId}/320 320w, https://app.example/images/${imageId}/640 640w`,
  }),
};

describe("buildReplyBlock", () => {
  it("builds a carousel of the presented covers, in the model's order, linked to their pages", () => {
    const ledger = TurnImageLedger.fromEvidence([1, 2, 3, 4, 5].map(product));

    const { block, dropped } = buildReplyBlock({
      head: { images: ["m3", "m1", "m5"], caption: "Three hiking guides" },
      ledger,
      layouts: carouselAndGrid,
    });

    expect(dropped).toEqual([]);
    expect(block).toEqual({
      type: "item_list",
      id: "b1",
      layout: "carousel",
      selection: "none",
      caption: "Three hiking guides",
      items: [3, 1, 5].map((index) => ({
        key: `cover-${index}`,
        title: `Field Guide ${index}`,
        image: { imageId: `cover-${index}`, width: 1280, height: 960, alt: "" },
        actions: [{ type: "open", url: `https://shop.example/books/guide-${index}` }],
      })),
    });
  });

  it("drops a handle that is not in this turn's evidence, and a URL given in place of a handle", () => {
    const ledger = TurnImageLedger.fromEvidence([product(1), product(2)]);

    const { block, dropped } = buildReplyBlock({
      head: { images: ["m2", "m9", "https://evil.example/pixel.gif", "[m1]"], caption: "Guides" },
      ledger,
      layouts: carouselAndGrid,
    });

    expect(block?.items.map((item) => item.key)).toEqual(["cover-2", "cover-1"]);
    expect(dropped).toEqual(["unknown_handle", "unknown_handle"]);
  });

  it("drops a repeated handle", () => {
    const ledger = TurnImageLedger.fromEvidence([product(1), product(2)]);

    const { block, dropped } = buildReplyBlock({ head: { images: ["m1", "m2", "m1"], caption: "Guides" }, ledger, layouts: carouselAndGrid });

    expect(block?.items).toHaveLength(2);
    expect(dropped).toEqual(["duplicate_handle"]);
  });

  it("builds no block from an empty pick or a pick of unknown handles", () => {
    const ledger = TurnImageLedger.fromEvidence([product(1)]);

    expect(buildReplyBlock({ head: { images: [], caption: "None" }, ledger, layouts: carouselAndGrid }).block).toBeNull();
    expect(buildReplyBlock({ head: { images: ["m7"], caption: "None" }, ledger, layouts: carouselAndGrid })).toEqual({
      block: null,
      dropped: ["unknown_handle"],
    });
  });

  it("keeps at most 10 items", () => {
    const ledger = TurnImageLedger.fromEvidence(Array.from({ length: 12 }, (_, index) => product(index + 1)));

    const { block, dropped } = buildReplyBlock({
      head: { images: Array.from({ length: 12 }, (_, index) => `m${index + 1}`), caption: "Guides" },
      ledger,
      layouts: carouselAndGrid,
    });

    expect(block?.items).toHaveLength(10);
    expect(dropped).toEqual(["over_limit", "over_limit"]);
  });

  it("lays inline pictures out as a grid, titled by caption, then alt text, then the document title", () => {
    const ledger = TurnImageLedger.fromEvidence([{
      resultNumber: 1,
      documentId: "doc-1",
      documentTitle: "The Guest House",
      sourceUrl: "https://stay.example/guest-house",
      images: [
        image("garden", { role: "inline", caption: "The garden", alt: "Garden with roses" }),
        image("room", { role: "inline", alt: "Room with a view" }),
        image("hall", { role: "inline" }),
      ],
    }]);

    const { block } = buildReplyBlock({ head: { images: ["m1", "m2", "m3"], caption: "The guest house" }, ledger, layouts: carouselAndGrid });

    expect(block?.layout).toBe("grid");
    expect(block?.items.map((item) => item.title)).toEqual(["The garden", "Room with a view", "The Guest House"]);
  });

  it("lays out a mix of covers and inline pictures as a grid", () => {
    const ledger = TurnImageLedger.fromEvidence([
      product(1),
      { ...product(2), images: [image("inline-2", { role: "inline", alt: "Inside" })] },
    ]);

    const { block } = buildReplyBlock({ head: { images: ["m1", "m2"], caption: "Both" }, ledger, layouts: carouselAndGrid });

    expect(block?.layout).toBe("grid");
  });

  it("falls back to list for a layout the client did not declare", () => {
    const ledger = TurnImageLedger.fromEvidence([product(1), product(2)]);

    expect(buildReplyBlock({ head: { images: ["m1", "m2"], caption: "Guides" }, ledger, layouts: ["grid"] }).block?.layout).toBe("list");
    expect(buildReplyBlock({ head: { images: ["m1", "m2"], caption: "Guides" }, ledger, layouts: [] }).block?.layout).toBe("list");
  });

  it("links an item only to an http(s) address", () => {
    const ledger = TurnImageLedger.fromEvidence([
      { ...product(1), sourceUrl: "ftp://shop.example/guide" },
      { ...product(2), sourceUrl: undefined },
    ]);

    const { block } = buildReplyBlock({ head: { images: ["m1", "m2"], caption: "Guides" }, ledger, layouts: carouselAndGrid });

    expect(block?.items.map((item) => item.actions)).toEqual([[], []]);
  });

  it("caps the caption at 120 characters and the title at 160", () => {
    const ledger = TurnImageLedger.fromEvidence([{ ...product(1), documentTitle: "t".repeat(400) }]);

    const { block } = buildReplyBlock({ head: { images: ["m1"], caption: "c".repeat(300) }, ledger, layouts: carouselAndGrid });

    expect(block?.caption).toHaveLength(120);
    expect(block?.items[0]?.title).toHaveLength(160);
  });
});

describe("presentReplyBlocks", () => {
  it("takes src and srcSet from the image URLs port only", () => {
    const ledger = TurnImageLedger.fromEvidence([product(1)]);
    const { block } = buildReplyBlock({ head: { images: ["m1"], caption: "Guide" }, ledger, layouts: carouselAndGrid });

    const [presented] = presentReplyBlocks([block!], urls);

    expect(presented?.items[0]?.image).toEqual({
      src: "https://app.example/images/cover-1/640",
      srcSet: "https://app.example/images/cover-1/320 320w, https://app.example/images/cover-1/640 640w",
      width: 1280,
      height: 960,
      alt: "",
    });
    expect(presented?.items[0]?.key).toBe("cover-1");
  });
});
