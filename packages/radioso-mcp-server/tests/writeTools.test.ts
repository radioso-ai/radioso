import { describe, expect, it, vi } from "vitest";

import { createWriteToolDefinitions } from "../src/tools/writeTools.js";

describe("createWriteToolDefinitions", () => {
  it("exposes the expected write tools", () => {
    const tools = createWriteToolDefinitions();

    expect(tools.map((tool) => tool.name)).toEqual([
      "create_document",
      "update_document",
      "delete_document",
      "reprocess_document",
    ]);
    expect(tools.map((tool) => tool.name)).not.toContain("update_retrieval_settings");
  });

  it("passes document enrichment override to reprocess_document", async () => {
    const tool = createWriteToolDefinitions().find((definition) => definition.name === "reprocess_document");
    expect(tool).toBeDefined();
    const adapter = {
      reprocessDocument: vi.fn().mockResolvedValue({ documentId: "doc-1", status: "queued" }),
    };

    const result = await tool!.execute(
      { documentId: "doc-1", documentEnrichmentOverride: "off" },
      { adapter } as never,
    );

    expect(adapter.reprocessDocument).toHaveBeenCalledWith("doc-1", {
      documentEnrichmentOverride: "off",
    });
    expect(result.data).toEqual({ documentId: "doc-1", status: "queued" });
  });
});
