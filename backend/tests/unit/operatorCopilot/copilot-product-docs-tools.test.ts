import { describe, expect, it, vi } from "vitest";

import { createProductDocsCopilotTools } from "../../../src/modules/operatorCopilot/tools/productDocs.js";
import { ProductDocsService } from "../../../src/modules/productDocs/public.js";

const context = {
  workspaceId: "workspace-1",
  accountId: "account-1",
  operatorUserId: "operator-1",
  surface: "dashboard" as const,
  currentAuthorization: { hasAllPermissions: vi.fn(async () => true) },
  pageContext: { view: "other" as const, agentId: null, conversationId: null, selection: null, entities: [] },
};

const descriptors = createProductDocsCopilotTools({ productDocs: new ProductDocsService() });
const [indexDescriptor, pageDescriptor] = descriptors;

const invokeIndex = () => indexDescriptor.createTool(context).invoke({}, {} as never) as Promise<Record<string, any>>;
const invokePage = (input: { slug: string; section?: string }) =>
  pageDescriptor.createTool(context).invoke(input, {} as never) as Promise<Record<string, any>>;

describe("product documentation copilot tools", () => {
  it("declares two free reads governed by the lowest workspace permission", () => {
    expect(descriptors.map((descriptor) => descriptor.name)).toEqual(["product_docs", "product_doc_page"]);
    for (const descriptor of descriptors) {
      expect(descriptor.shape).toBe("read");
      expect(descriptor.verificationCost({})).toBe(0);
      expect(descriptor.requiredPermissions).toEqual(["workspace.summary.read"]);
      expect(descriptor.dashboardSubject).toEqual({ type: "documentation" });
    }
  });

  it("separates itself from the workspace's own documents in both descriptions", () => {
    for (const descriptor of descriptors) {
      expect(descriptor.description).toContain("document_search");
    }
  });

  it("lists every page with the slug and headings needed to choose one", async () => {
    const result = await invokeIndex();

    expect(result.pages.length).toBeGreaterThan(20);
    const mcpPage = result.pages.find((listed: Record<string, unknown>) => listed.slug === "guides/mcp-server");
    expect(mcpPage.url).toBe("https://docs.radioso.ai/guides/mcp-server");
    expect(mcpPage.headings.length).toBeGreaterThan(0);
  });

  it("reads a whole short page in one call", async () => {
    const result = await invokePage({ slug: "guides/authoring-directives" });

    expect(result.found).toBe(true);
    expect(result.page.title).toBe("Author a directive");
    expect(result.page.sections.length).toBeGreaterThan(0);
    expect(result.page.sections.some((section: Record<string, string>) => section.body.length > 500)).toBe(true);
  });

  it("returns a long page as an outline, then serves its sections individually", async () => {
    const outline = await invokePage({ slug: "operators/copilot" });

    expect(outline.found).toBe(true);
    expect(outline.page.sections).toEqual([]);
    expect(outline.page.sectionsOmitted.length).toBeGreaterThan(0);

    const section = await invokePage({ slug: "operators/copilot", section: outline.page.sectionsOmitted[0].id });
    expect(section.found).toBe(true);
    expect(section.page.sections).toHaveLength(1);
  });

  it("names the pages that exist when a slug does not resolve", async () => {
    const result = await invokePage({ slug: "guides/imagined-page" });

    expect(result.found).toBe(false);
    expect(result.availableSlugs).toContain("guides/mcp-server");
  });

  it("names the sections that exist when a section does not resolve", async () => {
    const result = await invokePage({ slug: "guides/mcp-server", section: "imagined-section" });

    expect(result.found).toBe(false);
    expect(result.availableSections.length).toBeGreaterThan(0);
  });

  it("accepts the URL path a reader would copy out of the portal", async () => {
    const result = await invokePage({ slug: "/guides/mcp-server" });

    expect(result.page.slug).toBe("guides/mcp-server");
  });
});
