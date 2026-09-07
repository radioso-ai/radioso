import { describe, expect, it } from "vitest";

import { buildStorageCollection } from "../../support/appStorageCollections.js";
import { evaluateStorageCompatibility } from "../../../src/modules/appStorage/public.js";

const active = [buildStorageCollection()];

const findingCodes = (candidate: ReturnType<typeof buildStorageCollection>[]): string[] =>
  evaluateStorageCompatibility({ active, candidate }).findings.map((finding) => finding.code);

describe("evaluateStorageCompatibility", () => {
  it("accepts an identical declaration", () => {
    const report = evaluateStorageCompatibility({ active, candidate: [buildStorageCollection()] });
    expect(report).toEqual({ compatible: true, findings: [] });
  });

  it("accepts a collection the candidate adds", () => {
    const added = buildStorageCollection({ id: "cursors" });
    const report = evaluateStorageCompatibility({ active, candidate: [...active, added] });
    expect(report.compatible).toBe(true);
  });

  it("accepts an added optional field", () => {
    const candidate = buildStorageCollection({
      schemaVersion: 2,
      compatibleReaderVersions: [1, 2],
      recordSchema: {
        fields: [
          ...buildStorageCollection().recordSchema.fields,
          { key: "etag", type: "string", required: false },
        ],
      },
    });
    expect(evaluateStorageCompatibility({ active, candidate: [candidate] }).compatible).toBe(true);
  });

  it("accepts an added index and an added allowed operation", () => {
    const narrow = [buildStorageCollection({ allowedOperations: ["get", "put"] })];
    const candidate = buildStorageCollection({
      indexes: [
        { id: "by_external_id", field: "external_id" },
        { id: "by_sequence", field: "sequence" },
      ],
      allowedOperations: ["get", "put", "delete"],
    });
    expect(evaluateStorageCompatibility({ active: narrow, candidate: [candidate] }).compatible).toBe(true);
  });

  it("rejects an added required field, because stored records do not carry it", () => {
    const candidate = buildStorageCollection({
      recordSchema: {
        fields: [
          ...buildStorageCollection().recordSchema.fields,
          { key: "etag", type: "string", required: true },
        ],
      },
    });
    expect(findingCodes([candidate])).toContain("required_field_added");
  });

  it("rejects a removed field", () => {
    const candidate = buildStorageCollection({
      recordSchema: {
        fields: buildStorageCollection().recordSchema.fields.filter((field) => field.key !== "sequence"),
      },
    });
    expect(findingCodes([candidate])).toContain("field_removed");
  });

  it("rejects a changed field type", () => {
    const candidate = buildStorageCollection({
      recordSchema: {
        fields: buildStorageCollection().recordSchema.fields.map((field) =>
          field.key === "sequence" ? { ...field, type: "string" as const } : field,
        ),
      },
    });
    expect(findingCodes([candidate])).toContain("field_type_changed");
  });

  it("rejects tightening an optional field into a required one", () => {
    const candidate = buildStorageCollection({
      recordSchema: {
        fields: buildStorageCollection().recordSchema.fields.map((field) =>
          field.key === "sequence" ? { ...field, required: true } : field,
        ),
      },
    });
    expect(findingCodes([candidate])).toContain("field_requirement_tightened");
  });

  it("rejects removing an index a queued job may still query by", () => {
    const candidate = buildStorageCollection({ indexes: [] });
    expect(findingCodes([candidate])).toContain("index_removed");
  });

  it("rejects repointing an index at another field", () => {
    const candidate = buildStorageCollection({
      indexes: [{ id: "by_external_id", field: "sequence" }],
    });
    expect(findingCodes([candidate])).toContain("index_field_changed");
  });

  it("rejects dropping a collection whose records the active release stores", () => {
    expect(evaluateStorageCompatibility({ active, candidate: [] }).findings.map((f) => f.code)).toContain(
      "collection_removed",
    );
  });

  it("rejects a schema version that moves backwards", () => {
    const laterActive = [buildStorageCollection({ schemaVersion: 3, compatibleReaderVersions: [1, 2, 3] })];
    const candidate = buildStorageCollection({ schemaVersion: 2, compatibleReaderVersions: [1, 2] });
    const report = evaluateStorageCompatibility({ active: laterActive, candidate: [candidate] });
    expect(report.findings.map((finding) => finding.code)).toContain("schema_version_regressed");
  });

  it("rejects dropping a reader version an older installed release still declares", () => {
    const laterActive = [buildStorageCollection({ schemaVersion: 2, compatibleReaderVersions: [1, 2] })];
    const candidate = buildStorageCollection({ schemaVersion: 2, compatibleReaderVersions: [2] });
    const report = evaluateStorageCompatibility({ active: laterActive, candidate: [candidate] });
    expect(report.findings.map((finding) => finding.code)).toContain("reader_version_dropped");
  });

  it("names the collection and the declaration at fault without quoting stored data", () => {
    const candidate = buildStorageCollection({ indexes: [] });
    const [finding] = evaluateStorageCompatibility({ active, candidate: [candidate] }).findings;
    expect(finding?.collectionId).toBe("sync_state");
    expect(finding?.detail).toContain("by_external_id");
  });
});
