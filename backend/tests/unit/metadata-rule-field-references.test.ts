import { describe, expect, it } from "vitest";

import { collectMetadataRuleFieldKeys } from "../../src/modules/retrieval/domain/metadataRuleFieldReferences.js";
import { MetadataRuleFieldReferenceService } from "../../src/modules/retrieval/services/metadataRuleFieldReferenceService.js";

describe("collectMetadataRuleFieldKeys", () => {
  it("reads the rule field and every condition field", () => {
    const keys = collectMetadataRuleFieldKeys({
      metadataRules: [
        {
          id: "rule-1",
          field: "category",
          valueType: "string",
          operator: "equals",
          value: "shoes",
          conditions: [
            { id: "c1", field: "category", valueType: "string", operator: "equals", value: "shoes" },
            { id: "c2", field: "price", valueType: "number", operator: "lt", value: "50" },
          ],
          effect: "filter",
          enabled: true,
          triggerMode: "always_on",
        },
      ],
    });

    expect(keys).toEqual(["category", "price"]);
  });

  it("counts a disabled rule as a reference so a delete still warns", () => {
    const keys = collectMetadataRuleFieldKeys({
      metadataRules: [
        { id: "r", field: "availableFrom", valueType: "date", operator: "gte", value: "today()", effect: "boost", enabled: false, triggerMode: "always_on" },
      ],
    });

    expect(keys).toEqual(["availableFrom"]);
  });

  it("ignores configs without metadata rules and malformed entries", () => {
    expect(collectMetadataRuleFieldKeys({})).toEqual([]);
    expect(collectMetadataRuleFieldKeys(null)).toEqual([]);
    expect(collectMetadataRuleFieldKeys({ metadataRules: "nope" })).toEqual([]);
    expect(
      collectMetadataRuleFieldKeys({
        metadataRules: [{ field: "" }, { field: 7 }, { conditions: [{ field: "   " }] }, "junk"],
      }),
    ).toEqual([]);
  });
});

describe("MetadataRuleFieldReferenceService", () => {
  it("returns the distinct sorted keys referenced across every agent in the workspace", async () => {
    const service = new MetadataRuleFieldReferenceService({
      async listByWorkspace(workspaceId: string) {
        expect(workspaceId).toBe("workspace-1");
        return [
          { config: { metadataRules: [{ field: "price" }, { field: "category" }] } },
          { config: { metadataRules: [{ field: "category" }, { field: "audience" }] } },
          { config: { instruction: "no rules here" } },
        ];
      },
    });

    expect(await service.listReferencedFieldKeys("workspace-1")).toEqual([
      "audience",
      "category",
      "price",
    ]);
  });

  it("returns nothing when no agent declares a metadata rule", async () => {
    const service = new MetadataRuleFieldReferenceService({
      async listByWorkspace() {
        return [];
      },
    });

    expect(await service.listReferencedFieldKeys("workspace-1")).toEqual([]);
  });
});
