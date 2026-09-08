import { describe, expect, it } from "vitest";

import {
  listProductDocs,
  normalizeSlug,
  productDocsPageCount,
  readProductDoc,
  readProductDocSection,
} from "../src/index.js";

describe("product documentation corpus", () => {
  it("publishes every portal page with the fields a reader needs to choose one", () => {
    const docs = listProductDocs();

    expect(docs.length).toBe(productDocsPageCount);
    expect(docs.length).toBeGreaterThan(20);
    for (const doc of docs) {
      expect(doc.slug).not.toBe("");
      expect(doc.title.length).toBeGreaterThan(0);
      expect(doc.description.length).toBeGreaterThan(0);
      expect(doc.url.startsWith("https://docs.radioso.ai")).toBe(true);
    }
  });

  it("keeps slugs unique so a lookup is unambiguous", () => {
    const slugs = listProductDocs().map((doc) => doc.slug);

    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("resolves a page from the path a reader would copy out of the portal", () => {
    const bare = readProductDoc("guides/mcp-server");

    expect(bare?.title).toBe("MCP server");
    expect(readProductDoc("/guides/mcp-server/")?.slug).toBe("guides/mcp-server");
    expect(readProductDoc("https://docs.radioso.ai/guides/mcp-server")?.slug).toBe("guides/mcp-server");
    expect(readProductDoc(bare!.url)?.slug).toBe("guides/mcp-server");
    expect(normalizeSlug("/")).toBe("index");
    expect(readProductDoc("/")?.slug).toBe("index");
  });

  it("returns null rather than a near match for an unknown page", () => {
    expect(readProductDoc("guides/does-not-exist")).toBeNull();
    expect(readProductDocSection("guides/does-not-exist", "anything")).toBeNull();
  });

  it("addresses a section by its id or its heading text", () => {
    const page = readProductDoc("guides/mcp-server");
    const first = page?.sections[0];

    expect(first).toBeDefined();
    expect(readProductDocSection("guides/mcp-server", first!.id)?.heading).toBe(first!.heading);
    expect(readProductDocSection("guides/mcp-server", first!.heading.toUpperCase())?.id).toBe(first!.id);
  });

  it("lists a page's headings so one call is enough to pick a section", () => {
    const summary = listProductDocs().find((doc) => doc.slug === "guides/mcp-server");
    const page = readProductDoc("guides/mcp-server");

    expect(summary?.headings).toEqual(page?.sections.map((section) => section.heading));
  });

  it("flattens MDX scaffolding while keeping fenced example code intact", () => {
    const page = readProductDoc("sdk/basic-usage");
    const text = [page?.intro, ...(page?.sections ?? []).map((section) => section.body)].join("\n");

    expect(text).toContain("import { createRadiosoClient");
    expect(text).not.toContain("nextra/components");
    expect(text).not.toContain("<Callout");
    expect(text).not.toContain("<Steps>");
  });

  it("rewrites in-page links to absolute documentation URLs a client can follow", () => {
    const page = readProductDoc("guides/mcp-server");
    const readNext = page?.sections.find((section) => section.heading === "Read next");

    expect(readNext?.body).toContain("https://docs.radioso.ai/guides/authentication");
    expect(readNext?.body).not.toMatch(/\]\(\/guides\//);
  });

  it("normalizes every recorded update date to an ISO day", () => {
    const dates = listProductDocs().map((doc) => doc.lastUpdated).filter((value): value is string => value !== null);

    expect(dates.length).toBeGreaterThan(0);
    for (const date of dates) {
      expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("carries no page whose body is empty, which would answer a question with silence", () => {
    for (const doc of listProductDocs()) {
      const page = readProductDoc(doc.slug);
      const text = [page?.intro, ...(page?.sections ?? []).map((section) => section.body)].join("").trim();
      expect(text.length, `${doc.slug} compiled to an empty page`).toBeGreaterThan(0);
    }
  });
});
