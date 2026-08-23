import { describe, expect, it } from "vitest";

import { mergeMetadataFieldSuggestions } from "../../src/modules/settings/domain/metadataFieldSuggestions.js";
import { MetadataFieldSuggestionService } from "../../src/modules/settings/services/metadataFieldSuggestionService.js";

describe("mergeMetadataFieldSuggestions", () => {
  it("unions declared catalog fields with keys observed on document metadata", () => {
    const merged = mergeMetadataFieldSuggestions(
      [
        { key: "price", valueType: "number" },
        { key: "category", valueType: "string" },
      ],
      [
        { field: "language", inferredType: "string" },
        { field: "parsedData.url", inferredType: "string" },
      ],
    );

    expect(merged).toEqual([
      { field: "category", inferredType: "string" },
      { field: "language", inferredType: "string" },
      { field: "parsedData.url", inferredType: "string" },
      { field: "price", inferredType: "number" },
    ]);
  });

  it("lets the declared value type win when a key exists in both sources", () => {
    const merged = mergeMetadataFieldSuggestions(
      [{ key: "price", valueType: "number" }],
      [{ field: "price", inferredType: "string" }],
    );

    expect(merged).toEqual([{ field: "price", inferredType: "number" }]);
  });

  it("keeps the first declaration when the same key is declared twice", () => {
    const merged = mergeMetadataFieldSuggestions(
      [
        { key: "price", valueType: "number" },
        { key: "price", valueType: "number" },
      ],
      [],
    );

    expect(merged).toEqual([{ field: "price", inferredType: "number" }]);
  });

  it("returns observed keys untouched when the catalog declares nothing", () => {
    expect(mergeMetadataFieldSuggestions([], [{ field: "language", inferredType: "string" }])).toEqual([
      { field: "language", inferredType: "string" },
    ]);
  });
});

describe("MetadataFieldSuggestionService", () => {
  it("composes the catalog declarations and the observed keys for a workspace", async () => {
    const service = new MetadataFieldSuggestionService(
      {
        async listDeclaredMetadataFields(workspaceId: string) {
          expect(workspaceId).toBe("workspace-1");
          return [
            { key: "dateFrom", valueType: "date" as const },
            { key: "price", valueType: "number" as const },
          ];
        },
      },
      {
        async listMetadataFieldSuggestions(workspaceId: string) {
          expect(workspaceId).toBe("workspace-1");
          return [{ field: "language", inferredType: "string" as const }];
        },
      },
    );

    expect(await service.listMetadataFieldSuggestions("workspace-1")).toEqual([
      { field: "dateFrom", inferredType: "date" },
      { field: "language", inferredType: "string" },
      { field: "price", inferredType: "number" },
    ]);
  });
});
