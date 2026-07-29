import { describe, expect, it } from "vitest";

import { createOpenApiDocument } from "../../src/app/http/openapi/openApiDocument.js";

describe("quality grounding OpenAPI contract", () => {
  it("represents grounding as a diagnostic object or a real null union", () => {
    const document = createOpenApiDocument();
    const lowQualityTurn = document.components?.schemas?.LowQualityTurn as {
      properties?: { grounding?: { anyOf?: Array<Record<string, unknown>> } };
    };
    expect(lowQualityTurn.properties?.grounding?.anyOf).toEqual(expect.arrayContaining([
      { $ref: "#/components/schemas/GroundingDiagnostic" },
      { type: "null" },
    ]));
  });
});
