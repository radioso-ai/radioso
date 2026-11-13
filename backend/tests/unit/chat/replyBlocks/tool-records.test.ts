import { describe, expect, it } from "vitest";

import {
  resolveJsonPointer,
  TOOL_RECORD_LIMITS,
  ToolRecordLedger,
} from "../../../../src/modules/chat/services/replyBlocks/toolRecords.js";
import { estimateTextGenerationInputTokens } from "../../../../src/shared/infra/llm/modelInferencePipeline.js";

const listing = (index: number) => ({
  name: `Flat ${index}`,
  rent: 1500 + index,
  url: `https://homes.example/listings/flat-${index}`,
  photos: [{ url: `https://img.homes.example/photos/flat-${index}/front.jpg` }],
});

describe("tool record ledger", () => {
  it("offers each object of an array as a record, in document order across nested arrays", () => {
    const ledger = ToolRecordLedger.fromOutcome({
      results: { listings: [listing(1), listing(2)] },
      agents: [{ name: "Ada" }],
    }, undefined);

    expect(ledger.size).toBe(3);
    expect(ledger.record("r1")).toMatchObject({ key: "/results/listings/0", value: listing(1) });
    expect(ledger.record("r2")).toMatchObject({ key: "/results/listings/1" });
    expect(ledger.record("r3")).toMatchObject({ key: "/agents/0", value: { name: "Ada" } });
  });

  it("reads an array MCP wrapped as structured content", () => {
    const ledger = ToolRecordLedger.fromOutcome({ structuredContent: [listing(1)] }, undefined);

    expect(ledger.record("r1")).toMatchObject({ key: "/structuredContent/0", value: listing(1) });
  });

  it("does not make a record's own arrays of objects into records beside it", () => {
    const ledger = ToolRecordLedger.fromOutcome({ listings: [listing(1)] }, undefined);

    expect(ledger.size).toBe(1);
  });

  it("offers the outputs themselves as one record when they hold no array of objects", () => {
    const ledger = ToolRecordLedger.fromOutcome({ status: "shipped", tracking: "https://post.example/t/42" }, undefined);

    expect(ledger.size).toBe(1);
    expect(ledger.record("r1")).toMatchObject({ key: "/", value: { status: "shipped" } });
  });

  it("offers nothing for empty outputs, or an array of plain values", () => {
    expect(ToolRecordLedger.fromOutcome({}, undefined).size).toBe(0);
    expect(ToolRecordLedger.fromOutcome(undefined, undefined).size).toBe(0);
    expect(ToolRecordLedger.fromOutcome({ structuredContent: [] }, undefined).promptSection()).toContain("[r1]");
  });

  it("leaves an array deeper than the walk reaches", () => {
    const deep = { a: { b: { c: { d: { e: [listing(1)] } } } } };

    // The array sits at depth 5, so the outputs themselves are the one record.
    expect(ToolRecordLedger.fromOutcome(deep, undefined).record("r1")?.key).toBe("/");
    expect(ToolRecordLedger.fromOutcome({ a: { b: { c: { d: [listing(1)] } } } }, undefined).record("r1")?.key).toBe("/a/b/c/d/0");
  });

  it("offers each image the skill returned as bytes as a record naming this turn's token", () => {
    const ledger = ToolRecordLedger.fromOutcome({ listings: [listing(1)] }, [
      { kind: "image", imageId: "image-a" },
      { kind: "image", imageId: "image-b" },
    ]);

    expect(ledger.record("r2")).toMatchObject({ key: "media/1", value: { image: "tool-image:1" } });
    expect(ledger.mediaImageId("tool-image:2")).toBe("image-b");
    expect(ledger.mediaImageId("tool-image:3")).toBeUndefined();
    expect(ledger.mediaImageId("tool-image:0")).toBeUndefined();
    expect(ledger.mediaImageId("https://homes.example/a.jpg")).toBeUndefined();
  });

  it("offers at most twenty records and says how many it left out", () => {
    const ledger = ToolRecordLedger.fromOutcome({ listings: Array.from({ length: 25 }, (_v, index) => listing(index)) }, undefined);

    expect(ledger.size).toBe(TOOL_RECORD_LIMITS.records);
    expect(ledger.record("r21")).toBeUndefined();
    expect(ledger.hidden).toBe(5);
    expect(ledger.promptSection()).toContain("(5 more records not shown)");
  });

  it("shows a record within its depth, key, item and length caps", () => {
    const record = {
      title: "x".repeat(300),
      tags: ["a", "b", "c", "d", "e"],
      ...Object.fromEntries(Array.from({ length: 14 }, (_v, index) => [`k${index}`, index])),
      nested: { one: { two: { three: { four: "deep" } } } },
    };
    const section = ToolRecordLedger.fromOutcome({ items: [record] }, undefined).promptSection();
    const shown = JSON.parse(section.split("\n")[1]!.replace(/^\[r1\] /, "")) as Record<string, unknown>;

    expect(Array.from(shown.title as string)).toHaveLength(TOOL_RECORD_LIMITS.stringLength);
    expect(shown.tags).toEqual(["a", "b", "c", "+2"]);
    expect(Object.keys(shown)).toHaveLength(TOOL_RECORD_LIMITS.recordKeys + 1);
    expect(shown["…"]).toBe("+5 keys");
  });

  it("expands a record three containers deep, as a table row's photo field needs", () => {
    const row = { id: "rec1", fields: { Name: "Loft", Photos: [{ url: "https://dl.airtable.example/v1/abc/loft.jpg?sig=secret" }] } };
    const section = ToolRecordLedger.fromOutcome({ records: [row] }, undefined).promptSection();

    expect(section).toContain('"Photos":[{"url":"https://dl.airtable.example/…/loft.jpg"}]');
    expect(section).not.toContain("sig=secret");
  });

  it("cuts a long address to its origin and last segment, and says a cut one is incomplete", () => {
    const url = `https://homes.example/${"segment/".repeat(30)}photo.jpg`;
    const section = ToolRecordLedger.fromOutcome({ items: [{ url }] }, undefined).promptSection();

    expect(section).toContain('"url":"https://homes.example/…/photo.jpg"');
    expect(section.split("\n")[0]).toContain("An address shortened with … is incomplete");
  });

  it("shows a short address with no query whole, so a reply can link to it", () => {
    const section = ToolRecordLedger.fromOutcome({ offices: [{ name: "Mitte office", url: "https://homes.example/offices/mitte" }] }, undefined).promptSection();

    expect(section).toContain('"url":"https://homes.example/offices/mitte"');
  });

  it("shortens an address that carries a query, such as a signed link, whatever its length", () => {
    const section = ToolRecordLedger.fromOutcome({ photos: [{ url: "https://img.homes.example/a.jpg?sig=secret" }] }, undefined).promptSection();

    expect(section).toContain('"url":"https://img.homes.example/…/a.jpg"');
    expect(section).not.toContain("secret");
  });

  it("trims records from the end until the section fits its token budget", () => {
    const bulky = Array.from({ length: 20 }, (_v, index) => ({
      ...Object.fromEntries(Array.from({ length: 12 }, (_w, key) => [`field${key}`, `${"word ".repeat(23)}${index}`])),
    }));
    const ledger = ToolRecordLedger.fromOutcome({ rows: bulky }, undefined);

    expect(ledger.size).toBeLessThan(20);
    expect(ledger.size).toBeGreaterThan(0);
    expect(estimateTextGenerationInputTokens({ prompt: ledger.promptSection() })).toBeLessThanOrEqual(3_000);
    expect(ledger.record(`r${ledger.size + 1}`)).toBeUndefined();
  });

  it("hashes a key that is too long to carry", () => {
    const key = "k".repeat(200);
    const ledger = ToolRecordLedger.fromOutcome({ [key]: [{ name: "A" }] }, undefined);

    expect(ledger.record("r1")?.key).toMatch(/^sha256:[0-9a-f]{40}$/);
  });
});

describe("JSON pointer resolution", () => {
  const record = {
    name: "Loft",
    "a/b": 1,
    "m~n": 2,
    photos: [{ url: "https://img.homes.example/1.jpg" }, { url: "https://img.homes.example/2.jpg" }],
  };

  it("resolves keys, array indexes and escaped tokens against the whole record", () => {
    expect(resolveJsonPointer(record, "/name")).toBe("Loft");
    expect(resolveJsonPointer(record, "/photos/1/url")).toBe("https://img.homes.example/2.jpg");
    expect(resolveJsonPointer(record, "/a~1b")).toBe(1);
    expect(resolveJsonPointer(record, "/m~0n")).toBe(2);
    expect(resolveJsonPointer(record, "")).toBe(record);
  });

  it("reads a pointer written without its leading slash", () => {
    expect(resolveJsonPointer(record, "photos/0/url")).toBe("https://img.homes.example/1.jpg");
  });

  it("resolves nothing for a missing key, a bad index, or the end-of-array token", () => {
    expect(resolveJsonPointer(record, "/missing")).toBeUndefined();
    expect(resolveJsonPointer(record, "/photos/01/url")).toBeUndefined();
    expect(resolveJsonPointer(record, "/photos/-")).toBeUndefined();
    expect(resolveJsonPointer(record, "/name/0")).toBeUndefined();
    expect(resolveJsonPointer(record, "/toString")).toBeUndefined();
  });

  it("resolves past the view's truncation", () => {
    const long = { photos: Array.from({ length: 8 }, (_v, index) => ({ url: `https://img.homes.example/${index}.jpg` })) };

    expect(resolveJsonPointer(long, "/photos/6/url")).toBe("https://img.homes.example/6.jpg");
  });
});
