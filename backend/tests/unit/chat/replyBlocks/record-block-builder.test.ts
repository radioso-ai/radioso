import { describe, expect, it } from "vitest";

import { buildRecordBlock } from "../../../../src/modules/chat/services/replyBlocks/recordBlockBuilder.js";
import { readRecordPresentHead, type RecordPresentHead } from "../../../../src/modules/chat/services/replyBlocks/recordPresentHead.js";
import { ToolRecordLedger } from "../../../../src/modules/chat/services/replyBlocks/toolRecords.js";

const listing = (index: number, over: Record<string, unknown> = {}) => ({
  name: `Flat ${index}`,
  area: "Mitte",
  url: `https://homes.example/listings/flat-${index}`,
  photos: [{ url: `https://img.homes.example/photos/flat-${index}.jpg` }],
  ...over,
});

const head = (over: Partial<RecordPresentHead> = {}): RecordPresentHead => ({
  records: ["r1", "r2"],
  fields: { title: "/name", subtitle: "/area", image: "/photos/0/url", link: "/url" },
  caption: "Flats in Mitte",
  ...over,
});

const ids = () => {
  let next = 0;
  return () => `image-${++next}`;
};

const build = (over: Partial<RecordPresentHead>, outputs: Record<string, unknown> = { listings: [listing(1), listing(2), listing(3)] }) =>
  buildRecordBlock({
    head: head(over),
    ledger: ToolRecordLedger.fromOutcome(outputs, [{ kind: "image", imageId: "kept-1" }]),
    layouts: ["carousel", "grid"],
    skillName: "search_listings",
    newImageId: ids(),
  });

describe("record block builder", () => {
  it("builds each card from the record the model named, every value read from the data", () => {
    const { block, dropped, toolImages } = build({});

    expect(dropped).toEqual([]);
    expect(block).toEqual({
      type: "item_list",
      id: "b1",
      layout: "carousel",
      selection: "none",
      caption: "Flats in Mitte",
      origin: { kind: "skill_result", skillName: "search_listings" },
      items: [
        {
          key: "/listings/0",
          title: "Flat 1",
          description: "Mitte",
          image: { imageId: "image-1", width: 640, height: 480, alt: "Flat 1" },
          actions: [{ type: "open", url: "https://homes.example/listings/flat-1" }],
        },
        {
          key: "/listings/1",
          title: "Flat 2",
          description: "Mitte",
          image: { imageId: "image-2", width: 640, height: 480, alt: "Flat 2" },
          actions: [{ type: "open", url: "https://homes.example/listings/flat-2" }],
        },
      ],
    });
    expect(toolImages).toEqual([
      { kind: "url", imageId: "image-1", url: "https://img.homes.example/photos/flat-1.jpg" },
      { kind: "url", imageId: "image-2", url: "https://img.homes.example/photos/flat-2.jpg" },
    ]);
  });

  it("drops an unknown handle, a repeated one, and any past ten, and still builds the rest", () => {
    const outputs = { listings: Array.from({ length: 12 }, (_v, index) => listing(index)) };
    const records = ["r1", "[r1]", "r99", "nonsense", ...Array.from({ length: 11 }, (_v, index) => `r${index + 2}`)];

    const { block, dropped } = build({ records }, outputs);

    expect(block?.items).toHaveLength(10);
    expect(dropped).toEqual(["duplicate_record", "unknown_record", "unknown_record", "over_limit", "over_limit"]);
  });

  it("drops a card whose title is not text, and builds none when no card is left", () => {
    const { block, dropped } = build({ fields: { ...head().fields, title: "/photos" } });

    expect(block).toBeNull();
    expect(dropped).toEqual(["title_unresolved", "title_unresolved"]);
  });

  it("reads a number as a title, and cuts a long title and subtitle", () => {
    const outputs = { listings: [listing(1, { name: 42, area: "a".repeat(500) }), listing(2, { name: "t".repeat(300) })] };

    const { block } = build({}, outputs);

    expect(block?.items[0]).toMatchObject({ title: "42" });
    expect(block?.items[0]?.description).toHaveLength(400);
    expect(block?.items[1]?.title).toHaveLength(160);
  });

  it("leaves off a picture or link that is not a public http address, and counts it", () => {
    const outputs = {
      listings: [
        listing(1, { url: "javascript:alert(1)", photos: [{ url: "http://10.0.0.4/a.jpg" }] }),
        listing(2, { url: "https://user:pass@homes.example/x", photos: [{ url: "ftp://img.homes.example/a.jpg" }] }),
        listing(3, { url: "http://localhost/flat", photos: [{ url: "https://intranet.local/a.jpg" }] }),
      ],
    };

    const { block, dropped, toolImages } = build({ records: ["r1", "r2", "r3"] }, outputs);

    expect(block?.items.map((item) => [item.image, item.actions])).toEqual([[undefined, []], [undefined, []], [undefined, []]]);
    expect(dropped.filter((reason) => reason === "field_unresolved")).toHaveLength(6);
    expect(toolImages).toEqual([]);
    expect(block?.layout).toBe("list");
  });

  it("shows no picture field the model left null, and counts nothing for it", () => {
    const { block, dropped } = build({ fields: { title: "/name", subtitle: null, image: null, link: null } });

    expect(block?.items[0]).toEqual({ key: "/listings/0", title: "Flat 1", actions: [] });
    expect(block?.layout).toBe("list");
    expect(dropped).toEqual([]);
  });

  it("accepts the token of a picture the skill returned this turn, and no other token", () => {
    const outputs = { listings: [listing(1, { photos: [{ url: "tool-image:1" }] }), listing(2, { photos: [{ url: "tool-image:7" }] })] };

    const { block, toolImages } = build({}, outputs);

    expect(block?.items[0]?.image?.imageId).toBe("kept-1");
    expect(block?.items[1]?.image).toBeUndefined();
    expect(toolImages).toEqual([{ kind: "inline", imageId: "kept-1" }]);
  });

  it("gives one picture address one id however many cards show it", () => {
    const shared = [{ url: "https://img.homes.example/building.jpg" }];
    const outputs = { listings: [listing(1, { photos: shared }), listing(2, { photos: shared })] };

    const { block, toolImages } = build({}, outputs);

    expect(block?.items.map((item) => item.image?.imageId)).toEqual(["image-1", "image-1"]);
    expect(toolImages).toHaveLength(1);
  });

  it("keys a card by its record's place in the outputs", () => {
    const { block } = build({ records: ["r2"] }, { structuredContent: [listing(1), listing(2)] });

    expect(block?.items[0]?.key).toBe("/structuredContent/1");
  });

  it("lays cards out as a list for a client that draws no carousel", () => {
    const { block } = buildRecordBlock({
      head: head(),
      ledger: ToolRecordLedger.fromOutcome({ listings: [listing(1)] }, undefined),
      layouts: ["grid"],
      skillName: "search_listings",
      newImageId: ids(),
    });

    expect(block?.layout).toBe("list");
  });
});

describe("record present head", () => {
  it("reads the model's head, and nothing malformed", () => {
    const valid = { records: ["r1"], fields: { title: "/name", subtitle: null, image: "/photo", link: null }, caption: " Flats " };

    expect(readRecordPresentHead({ present: valid })).toEqual({ ...valid, caption: "Flats" });
    expect(readRecordPresentHead({ present: { ...valid, fields: { ...valid.fields, title: null } } })).toBeNull();
    expect(readRecordPresentHead({ present: { ...valid, records: [1] } })).toBeNull();
    expect(readRecordPresentHead({ present: { images: [], caption: "x" } })).toBeNull();
    expect(readRecordPresentHead(undefined)).toBeNull();
  });
});
