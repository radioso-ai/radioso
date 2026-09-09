import { describe, expect, it } from "vitest";

import { createProductDocsToolDefinitions } from "../src/tools/productDocsTools.js";
import type { ToolExecutionContext } from "../src/types.js";

const context = {} as ToolExecutionContext;
const [index, page] = createProductDocsToolDefinitions();

const asRecord = (value: unknown): Record<string, any> => value as Record<string, any>;

describe("product documentation MCP tools", () => {
  it("exposes the documentation surface under names that stay unambiguous in a multi-server client", () => {
    expect(createProductDocsToolDefinitions().map((tool) => tool.name)).toEqual([
      "radioso_docs",
      "radioso_doc_page",
    ]);
  });

  it("lists pages with the slugs the page tool accepts", async () => {
    const result = await index.execute({}, context);
    const data = asRecord(result.data);

    expect(data.pageCount).toBeGreaterThan(20);
    expect(data.pages.length).toBe(data.pageCount);
    for (const listed of data.pages) {
      expect(typeof listed.slug).toBe("string");
      expect(listed.url.startsWith("https://docs.radioso.ai")).toBe(true);
    }
    const [first] = data.pages;
    expect(asRecord((await page.execute({ slug: first.slug }, context)).data).found).toBe(true);
  });

  it("reads a page and cites its published URL", async () => {
    const data = asRecord((await page.execute({ slug: "guides/mcp-server" }, context)).data);

    expect(data.found).toBe(true);
    expect(data.page.title).toBe("MCP server");
    expect(data.page.url).toBe("https://docs.radioso.ai/guides/mcp-server");
    expect(data.page.sections.length).toBeGreaterThan(0);
  });

  it("answers an unknown slug with the available slugs rather than an error", async () => {
    const result = await page.execute({ slug: "guides/not-a-page" }, context);
    const data = asRecord(result.data);

    expect(data.found).toBe(false);
    expect(data.availableSlugs).toContain("guides/mcp-server");
    expect(result.summary).toContain("guides/not-a-page");
  });

  it("returns an outline instead of a clipped body for a long page", async () => {
    const data = asRecord((await page.execute({ slug: "operators/copilot" }, context)).data);

    expect(data.page.sections).toEqual([]);
    expect(data.page.sectionsOmitted.length).toBeGreaterThan(0);

    const sectionId = data.page.sectionsOmitted[0].id;
    const section = asRecord((await page.execute({ slug: "operators/copilot", section: sectionId }, context)).data);
    expect(section.found).toBe(true);
    expect(section.page.sections[0].body.length).toBeGreaterThan(0);
  });

  it("answers an unknown section with the sections that exist", async () => {
    const data = asRecord((await page.execute({ slug: "guides/mcp-server", section: "nope" }, context)).data);

    expect(data.found).toBe(false);
    expect(data.availableSections.length).toBeGreaterThan(0);
  });

  it("needs no converse session, because the documentation is the same for every workspace", async () => {
    await expect(index.execute({}, {} as ToolExecutionContext)).resolves.toBeDefined();
    await expect(page.execute({ slug: "index" }, {} as ToolExecutionContext)).resolves.toBeDefined();
  });
});
