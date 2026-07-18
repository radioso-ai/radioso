import { describe, expect, it } from "vitest";

import { createOpenApiDocument } from "../../src/app/http/openapi/openApiDocument.js";

describe("chat interruption HTTP contract", () => {
  it("documents the typed superseded outcome on every non-streaming chat surface", () => {
    const paths = createOpenApiDocument().paths;

    expect(paths?.["/api/v1/assistant/chat"]?.post?.responses?.[409]).toBeDefined();
    expect(paths?.["/api/v1/public/chat/{token}"]?.post?.responses?.[409]).toBeDefined();
    expect(paths?.["/api/v1/mcp/converse/ask"]?.post?.responses?.[409]).toBeDefined();
  });
});
