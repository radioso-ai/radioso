import { describe, expect, it } from "vitest";

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

});
