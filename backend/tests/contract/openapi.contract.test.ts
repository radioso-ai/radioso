import { readFileSync } from "node:fs";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import { createOpenApiDocument } from "../../src/app/http/openapi/document.js";

describe("openapi contract", () => {
  it("matches the checked-in generated yaml", () => {
    const yamlSpec = readFileSync(new URL("../../openapi.yaml", import.meta.url), "utf8");

    expect(parse(yamlSpec)).toEqual(createOpenApiDocument());
  });
});
