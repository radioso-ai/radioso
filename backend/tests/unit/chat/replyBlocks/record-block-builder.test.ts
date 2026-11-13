import { describe, expect, it } from "vitest";

import { storedReplyBlockSchema } from "../../../../src/modules/chat/contracts/replyBlocks.js";
import { buildRecordBlock } from "../../../../src/modules/chat/services/replyBlocks/recordBlockBuilder.js";
import { readRecordPresentHead, recordPresentHeadSchemaExtension, type RecordPresentHead } from "../../../../src/modules/chat/services/replyBlocks/recordPresentHead.js";
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
  selection: "none",
  ...over,
});

const ids = () => {
  let next = 0;
  return () => `image-${++next}`;
};

const build = (over: Partial<RecordPresentHead>, outputs: Record<string, unknown> = { listings: [listing(1), listing(2), listing(3)] }) =>
  buildRecordBlock({
    head: head(over),
    ledger: ToolRecordLedger.fromOutputs(outputs),
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
      { imageId: "image-1", url: "https://img.homes.example/photos/flat-1.jpg" },
      { imageId: "image-2", url: "https://img.homes.example/photos/flat-2.jpg" },
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

  it("leaves off a picture or link whose address outgrows the stored limit once percent-encoded", () => {
    // 2,024 characters as written; each ä becomes %C3%A4, so the stored form is 4,024 characters.
    const base = "https://img.homes.example/";
    const long = `${base}${"ä".repeat(400)}${"a".repeat(2024 - base.length - 400)}`;
    expect(long).toHaveLength(2024);
    const outputs = { listings: [listing(1, { url: long, photos: [{ url: long }] })] };

    const { block, dropped, toolImages } = build({ records: ["r1"] }, outputs);

    expect(block?.items[0]).toEqual({ key: "/listings/0", title: "Flat 1", description: "Mitte", actions: [] });
    expect(dropped).toEqual(["field_unresolved", "field_unresolved"]);
    expect(toolImages).toEqual([]);
  });

  it("cuts long text by the stored schema's UTF-16 length without splitting an emoji, so the block reads back", () => {
    const title = `${"🏠".repeat(100)}`;
    const subtitle = `${"x".repeat(399)}🌳 garden`;
    const outputs = { listings: [listing(1, { name: title, area: subtitle })] };

    const { block } = build({ records: ["r1"], caption: "🏡".repeat(70) }, outputs);

    const item = block!.items[0];
    expect(item.title.length).toBeLessThanOrEqual(160);
    expect(item.title).toBe("🏠".repeat(80));
    expect(item.description).toBe("x".repeat(399));
    expect(block!.caption).toBe("🏡".repeat(60));
    expect(storedReplyBlockSchema.safeParse(block).success).toBe(true);
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
      ledger: ToolRecordLedger.fromOutputs({ listings: [listing(1)] }),
      layouts: ["grid"],
      skillName: "search_listings",
      newImageId: ids(),
    });

    expect(block?.layout).toBe("list");
  });

  it("lets the visitor pick a card when the model offers a single selection, after each card's link", () => {
    const { block } = build({ selection: "single" });

    expect(block?.selection).toBe("single");
    expect(block?.items.map((item) => item.actions)).toEqual([
      [{ type: "open", url: "https://homes.example/listings/flat-1" }, { type: "select" }],
      [{ type: "open", url: "https://homes.example/listings/flat-2" }, { type: "select" }],
    ]);
    expect(storedReplyBlockSchema.safeParse(block).success).toBe(true);
  });
});

describe("record present head", () => {
  it("offers the selection as an enum the model returns", () => {
    const present = recordPresentHeadSchemaExtension().beforeAnswer?.properties.present as {
      required: string[];
      properties: Record<string, unknown>;
    };

    expect(present.required).toEqual(Object.keys(present.properties));
    expect(present.properties.selection).toMatchObject({ type: "string", enum: ["none", "single"] });
  });

  it("reads the model's head, and nothing malformed", () => {
    const valid = { records: ["r1"], fields: { title: "/name", subtitle: null, image: "/photo", link: null }, caption: " Flats ", selection: "single" };

    expect(readRecordPresentHead({ present: valid })).toEqual({ ...valid, caption: "Flats" });
    expect(readRecordPresentHead({ present: { ...valid, selection: undefined } })?.selection).toBe("none");
    expect(readRecordPresentHead({ present: { ...valid, fields: { ...valid.fields, title: null } } })).toBeNull();
    expect(readRecordPresentHead({ present: { ...valid, records: [1] } })).toBeNull();
    expect(readRecordPresentHead({ present: { images: [], caption: "x" } })).toBeNull();
    expect(readRecordPresentHead(undefined)).toBeNull();
  });
});
