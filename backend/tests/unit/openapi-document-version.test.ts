// First: Zod 4 gives `.openapi()` only to schemas built after this runs.
import "../../src/app/http/openapi/zodOpenApiExtension.js";
import { describe, expect, it } from "vitest";

import { createOpenApiDocument } from "../../src/app/http/openapi/openApiDocument.js";

const VERSIONED_API_PATH = /^\/api\/v(?<major>\d+)\//;

describe("OpenAPI document version", () => {
  it("names the API major that every documented /api path is served under", () => {
    const document = createOpenApiDocument();
    const servedMajors = new Set(
      Object.keys(document.paths ?? {}).flatMap((path) => {
        const major = VERSIONED_API_PATH.exec(path)?.groups?.major;
        return major ? [major] : [];
      }),
    );

    expect(servedMajors.size).toBeGreaterThan(0);
    expect([...servedMajors]).toEqual([document.info.version]);
  });
});
