import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { catalogCoverage } from "../../../src/modules/operatorCopilot/catalogCoverage.js";

describe("operator copilot catalog coverage", () => {
  it("maps every OpenAPI operation to a catalog tool or stated exclusion", async () => {
    const openApi = JSON.parse(await readFile(new URL("../../../openapi.json", import.meta.url), "utf8")) as {
      paths: Record<string, Record<string, { operationId?: string }>>;
    };
    const operationIds = Object.values(openApi.paths)
      .flatMap((path) => Object.values(path))
      .flatMap((operation) => operation.operationId ? [operation.operationId] : []);

    expect(Object.keys(catalogCoverage).sort()).toEqual([...operationIds].sort());
    for (const entry of Object.values(catalogCoverage)) {
      expect(typeof entry === "string" || ("excluded" in entry && entry.excluded.trim().length > 0)).toBe(true);
    }
  });
});
