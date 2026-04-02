import { describe, expect, it } from "vitest";
import { createOpenApiDocument } from "../../src/app/http/openapi/document.js";

describe("evals openapi contract", () => {
  it("documents eval dataset and run endpoints", () => {
    const spec = createOpenApiDocument();
    const createDatasetResponse =
      spec.paths?.["/api/v1/evals/datasets"]?.post?.responses?.["201"]?.content?.["application/json"]?.schema;

    expect(JSON.stringify(spec)).toContain("/api/v1/evals/datasets");
    expect(JSON.stringify(spec)).toContain("/api/v1/evals/import/chat-history");
    expect(JSON.stringify(spec)).toContain("/api/v1/evals/datasets/{datasetId}/runs/{runId}/comparison");
    expect(JSON.stringify(createDatasetResponse)).toContain("EvalDatasetSummary");
    expect(JSON.stringify(spec.components?.schemas?.EvalDatasetSummary)).toContain("caseCount");
    expect(JSON.stringify(spec.components?.schemas?.EvalDatasetSummary)).toContain("runCount");
    expect(JSON.stringify(spec.components?.schemas?.EvalDatasetSummary)).toContain("lastRunAt");
  });
});
