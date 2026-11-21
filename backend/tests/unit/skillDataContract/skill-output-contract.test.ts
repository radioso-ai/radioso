import { describe, expect, it } from "vitest";

import {
  checkSkillOutputs,
  readJsonPath,
  skillOutputContractFor,
  skillOutputsSchema,
  type SkillOutputDeclarations,
} from "../../../src/shared/domain/skillDataContract/index.js";

const ordersBody = {
  order: { number: "A-100", status: "shipped", total: "12.50", gift: "false", placed: "2026-11-20T09:00:00Z", internal: "never" },
  items: [
    { sku: "L-1", name: "Lamp", price: 30, photo: "https://cdn.example.com/lamp.jpg", secret: "x" },
    { sku: "B-2", name: "Bulb", price: "4.5" },
    { sku: "S-3", name: "Shade" },
  ],
  empty: [],
};

const declarations = (value: unknown): SkillOutputDeclarations => skillOutputsSchema.parse(value);

describe("skillOutputsSchema", () => {
  it("fills defaults: optional outputs, ten items per list", () => {
    expect(declarations({
      status: { path: "order.status", type: "text" },
      items: { path: "items", type: "list", fields: { name: { path: "name", type: "text", role: "title" } } },
    })).toEqual({
      status: { path: "order.status", type: "text", required: false },
      items: {
        path: "items",
        type: "list",
        required: false,
        maxItems: 10,
        fields: { name: { path: "name", type: "text", required: false, role: "title" } },
      },
    });
  });

  it("refuses a role twice in a list, a non-text image or link, a role on a scalar, and a list in a list", () => {
    const refused = [
      { items: { path: "items", type: "list", fields: { a: { path: "a", type: "text", role: "title" }, b: { path: "b", type: "text", role: "title" } } } },
      { items: { path: "items", type: "list", fields: { photo: { path: "photo", type: "number", role: "image" } } } },
      { items: { path: "items", type: "list", fields: { url: { path: "url", type: "date", role: "link" } } } },
      { status: { path: "status", type: "text", role: "title" } },
      { items: { path: "items", type: "list", fields: { inner: { path: "inner", type: "list", fields: {} } } } },
    ];
    for (const value of refused) {
      expect(skillOutputsSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
    }
  });

  it("refuses paths past ten segments, with empty or prototype segments, and maxItems outside 1..20", () => {
    expect(skillOutputsSchema.safeParse({ a: { path: "a.b.c.d.e.f.g.h.i.j.k", type: "text" } }).success).toBe(false);
    expect(skillOutputsSchema.safeParse({ a: { path: "a.b.c.d.e.f.g.h.i.j", type: "text" } }).success).toBe(true);
    for (const path of ["a..b", "", "a.__proto__", "constructor", "prototype.x"]) {
      expect(skillOutputsSchema.safeParse({ a: { path, type: "text" } }).success, path).toBe(false);
    }
    expect(skillOutputsSchema.safeParse({ items: { path: "items", type: "list", maxItems: 0, fields: {} } }).success).toBe(false);
    expect(skillOutputsSchema.safeParse({ items: { path: "items", type: "list", maxItems: 21, fields: {} } }).success).toBe(false);
  });

  it("refuses output and field names that are not variable names", () => {
    expect(skillOutputsSchema.safeParse({ "order-status": { path: "a", type: "text" } }).success).toBe(false);
    expect(skillOutputsSchema.safeParse({ items: { path: "items", type: "list", fields: { "item name": { path: "a", type: "text" } } } }).success).toBe(false);
  });
});

describe("readJsonPath", () => {
  it("reads own keys and indexes arrays by numeric segments, never inherited properties", () => {
    expect(readJsonPath(ordersBody, "order.status")).toEqual({ found: true, value: "shipped" });
    expect(readJsonPath(ordersBody, "items.1.name")).toEqual({ found: true, value: "Bulb" });
    expect(readJsonPath(ordersBody, "items.9.name")).toEqual({ found: false });
    expect(readJsonPath(ordersBody, "items.length")).toEqual({ found: false });
    expect(readJsonPath(ordersBody, "order.toString")).toEqual({ found: false });
  });
});

describe("checkSkillOutputs", () => {
  const outputs = declarations({
    number: { path: "order.number", type: "text", required: true, description: "Order number" },
    total: { path: "order.total", type: "number" },
    gift: { path: "order.gift", type: "boolean" },
    placed: { path: "order.placed", type: "date" },
    carrier: { path: "order.carrier", type: "text" },
    items: {
      path: "items",
      type: "list",
      maxItems: 2,
      description: "Items in the order",
      fields: {
        sku: { path: "sku", type: "text", role: "key" },
        name: { path: "name", type: "text", role: "title" },
        price: { path: "price", type: "number" },
        photo: { path: "photo", type: "text", role: "image" },
      },
    },
    none: { path: "empty", type: "list", fields: { name: { path: "name", type: "text" } } },
  });

  it("projects coerced scalars and lists cut to maxItems with exactly the declared fields", () => {
    expect(checkSkillOutputs(ordersBody, outputs, 16_384)).toEqual({
      kind: "checked",
      outputs: {
        number: "A-100",
        total: 12.5,
        gift: false,
        placed: "2026-11-20T09:00:00.000Z",
        items: [
          { sku: "L-1", name: "Lamp", price: 30, photo: "https://cdn.example.com/lamp.jpg" },
          { sku: "B-2", name: "Bulb", price: 4.5 },
        ],
      },
    });
  });

  it("leaves out a value that does not coerce, and treats an empty list as absent", () => {
    const result = checkSkillOutputs(
      { order: { number: "A-1", total: "lots" }, items: [] },
      declarations({
        number: { path: "order.number", type: "text" },
        total: { path: "order.total", type: "number" },
        items: { path: "items", type: "list", fields: { name: { path: "name", type: "text" } } },
      }),
      16_384,
    );
    expect(result).toEqual({ kind: "checked", outputs: { number: "A-1" } });
  });

  it("reports a required output that is absent as a mismatch, by name only", () => {
    const required = declarations({
      number: { path: "order.number", type: "number", required: true },
      items: { path: "missing", type: "list", required: true, fields: { name: { path: "name", type: "text" } } },
      status: { path: "order.status", type: "text", required: true },
    });

    expect(checkSkillOutputs(ordersBody, required, 16_384)).toEqual({ kind: "mismatch", missing: ["number", "items"] });
  });

  it("refuses outputs whose serialized size passes the cap", () => {
    const big = declarations({ note: { path: "note", type: "text" } });
    expect(checkSkillOutputs({ note: "x".repeat(200) }, big, 100)).toEqual({ kind: "too_large" });
  });
});

describe("skillOutputContractFor", () => {
  it("names each output's type and description, and each list's fields with their roles", () => {
    const outputs = declarations({
      status: { path: "order.status", type: "text", description: "Order status" },
      items: {
        path: "items",
        type: "list",
        fields: {
          name: { path: "name", type: "text", role: "title", description: "Item name" },
          price: { path: "price", type: "number" },
        },
      },
    });

    expect(skillOutputContractFor(outputs)).toEqual({
      status: { type: "text", description: "Order status" },
      items: {
        type: "list",
        fields: {
          name: { type: "text", description: "Item name", role: "title" },
          price: { type: "number" },
        },
      },
    });
  });
});
