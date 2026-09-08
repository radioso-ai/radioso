import { describe, expect, it } from "vitest";
import type { StorageCollection } from "@radioso/app-contract";

import { buildStorageCollection } from "../../support/appStorageCollections.js";
import {
  evaluateStorageCompatibility,
  type StorageCollectionObservation,
} from "../../../src/modules/appStorage/public.js";

const base = buildStorageCollection();

/**
 * One collection's observation. `survivingReaders` defaults to the base
 * declaration, because a case that says nothing about who is still reading is
 * saying the release being replaced still is — which is the ordinary rolling
 * activation. A case that says nothing about stored rows is saying there are
 * none, not that they are unknown.
 */
const observe = (
  input: Partial<StorageCollectionObservation> & { candidate: StorageCollection | null },
): StorageCollectionObservation => ({
  collectionId: input.candidate?.id ?? base.id,
  survivingReaders: [base],
  storedWriterVersions: [],
  ...input,
});

const evaluate = (
  input: Partial<StorageCollectionObservation> & { candidate: StorageCollection | null },
) => evaluateStorageCompatibility({ collections: [observe(input)] });

const findingCodes = (candidate: StorageCollection): string[] =>
  evaluate({ candidate }).findings.map((finding) => finding.code);

/** The same collection at a later version, with the readers such a release declares. */
const atVersion = (schemaVersion: number, overrides: Partial<StorageCollection> = {}): StorageCollection =>
  buildStorageCollection({
    schemaVersion,
    compatibleReaderVersions: Array.from({ length: schemaVersion }, (_unused, index) => index + 1),
    ...overrides,
  });

describe("evaluateStorageCompatibility", () => {
  it("accepts an identical declaration", () => {
    expect(evaluate({ candidate: buildStorageCollection() })).toEqual({
      compatible: true,
      findings: [],
      requiresIndexRebuild: [],
    });
  });

  it("accepts an added optional field, which every older reader may ignore", () => {
    // The reader at version 1 does not declare version 2 readable, but the two
    // declarations differ only by an optional field, so it can read what the
    // candidate writes whatever it declares.
    const candidate = atVersion(2, {
      recordSchema: {
        fields: [...base.recordSchema.fields, { key: "etag", type: "string", required: false }],
      },
    });
    expect(evaluate({ candidate }).compatible).toBe(true);
  });

  it("accepts an added allowed operation", () => {
    const candidate = buildStorageCollection({ allowedOperations: ["get", "put", "delete"] });
    const reader = buildStorageCollection({ allowedOperations: ["get", "put"] });
    expect(evaluate({ survivingReaders: [reader], candidate }).compatible).toBe(true);
  });

  it("rejects an added required field, because stored records do not carry it", () => {
    const candidate = atVersion(2, {
      recordSchema: {
        fields: [...base.recordSchema.fields, { key: "etag", type: "string", required: true }],
      },
    });
    expect(findingCodes(candidate)).toContain("required_field_added");
  });

  it("rejects a removed field", () => {
    const candidate = atVersion(2, {
      recordSchema: { fields: base.recordSchema.fields.filter((field) => field.key !== "sequence") },
    });
    expect(findingCodes(candidate)).toContain("field_removed");
  });

  it("rejects a changed field type", () => {
    const candidate = atVersion(2, {
      recordSchema: {
        fields: base.recordSchema.fields.map((field) =>
          field.key === "sequence" ? { ...field, type: "string" as const } : field,
        ),
      },
    });
    expect(findingCodes(candidate)).toContain("field_type_changed");
  });

  it("rejects tightening an optional field into a required one", () => {
    const candidate = atVersion(2, {
      recordSchema: {
        fields: base.recordSchema.fields.map((field) =>
          field.key === "sequence" ? { ...field, required: true } : field,
        ),
      },
    });
    expect(findingCodes(candidate)).toContain("field_requirement_tightened");
  });

  it("rejects loosening a required field, which an older reader still expects to be there", () => {
    // The candidate may then write a record without the field; a rollback release
    // or a queued job that requires it reads that record and finds it missing.
    const candidate = atVersion(2, {
      recordSchema: {
        fields: base.recordSchema.fields.map((field) =>
          field.key === "external_id" ? { ...field, required: false } : field,
        ),
      },
    });
    expect(findingCodes(candidate)).toContain("field_requirement_loosened");
  });

  it("rejects removing an index a surviving reader may still query by", () => {
    expect(findingCodes(buildStorageCollection({ indexes: [] }))).toContain("index_removed");
  });

  it("rejects repointing an index at another field", () => {
    const candidate = buildStorageCollection({ indexes: [{ id: "by_external_id", field: "sequence" }] });
    expect(findingCodes(candidate)).toContain("index_field_changed");
  });

  it("rejects narrowing allowedOperations, which turns a surviving reader's next call into denied", () => {
    const candidate = buildStorageCollection({ allowedOperations: ["get", "put", "delete"] });
    const report = evaluate({ candidate });
    expect(report.findings.map((finding) => finding.code)).toContain("allowed_operation_removed");
    expect(report.findings.some((finding) => finding.detail.includes("query_by_index"))).toBe(true);
  });

  it("rejects dropping a collection whose records a surviving release stores", () => {
    expect(evaluate({ candidate: null }).findings.map((finding) => finding.code)).toContain(
      "collection_removed",
    );
  });

  it("rejects reusing a schema version for a different record shape", () => {
    const candidate = buildStorageCollection({
      recordSchema: {
        fields: [...base.recordSchema.fields, { key: "etag", type: "string", required: false }],
      },
    });
    expect(findingCodes(candidate)).toContain("schema_version_reused");
  });

  it("rejects dropping the reader version a surviving release writes", () => {
    const reader = buildStorageCollection({ schemaVersion: 2, compatibleReaderVersions: [1, 2, 3] });
    const candidate = buildStorageCollection({ schemaVersion: 3, compatibleReaderVersions: [3] });
    expect(
      evaluate({ survivingReaders: [reader], candidate }).findings.map((finding) => finding.code),
    ).toContain("reader_version_dropped");
  });
});

/**
 * An observation names one collection, and a report attributed to it must have
 * been decided by that collection's declarations. Otherwise the answer is about
 * something other than the thing it names, and nothing in the result says so.
 */
describe("evaluateStorageCompatibility observation identity", () => {
  it("rejects an observation carrying a candidate declaration for another collection", () => {
    const report = evaluateStorageCompatibility({
      collections: [
        {
          collectionId: "sync_state",
          candidate: buildStorageCollection({ id: "cursors" }),
          survivingReaders: [base],
          storedWriterVersions: [],
        },
      ],
    });

    expect(report.findings.map((finding) => finding.code)).toContain("collection_mismatch");
    expect(report.findings[0]?.collectionId).toBe("sync_state");
  });

  it("rejects an observation carrying a surviving-reader declaration for another collection", () => {
    const report = evaluateStorageCompatibility({
      collections: [
        {
          collectionId: "sync_state",
          candidate: base,
          survivingReaders: [buildStorageCollection({ id: "cursors" })],
          storedWriterVersions: [],
        },
      ],
    });

    expect(report.findings.map((finding) => finding.code)).toContain("collection_mismatch");
  });
});

/**
 * The rules are three independent families, and a declaration belongs to exactly
 * one of them. `compatibleReaderVersions` is a claim about what a release can
 * parse; it establishes coverage and waives nothing, because no claim makes a
 * removed field readable.
 */
describe("evaluateStorageCompatibility additive-only rules", () => {
  it("rejects a removed field even when the candidate declares the active version readable", () => {
    const candidate = atVersion(2, {
      compatibleReaderVersions: [1, 2],
      recordSchema: { fields: base.recordSchema.fields.filter((field) => field.key !== "sequence") },
    });
    expect(findingCodes(candidate)).toContain("field_removed");
  });

  it("rejects a retyped field even when every version in the picture is declared readable", () => {
    const reader = buildStorageCollection({ compatibleReaderVersions: [1, 2] });
    const candidate = atVersion(2, {
      compatibleReaderVersions: [1, 2],
      recordSchema: {
        fields: base.recordSchema.fields.map((field) =>
          field.key === "sequence" ? { ...field, type: "string" as const } : field,
        ),
      },
    });
    expect(
      evaluate({ survivingReaders: [reader], candidate }).findings.map((finding) => finding.code),
    ).toContain("field_type_changed");
  });

  it("rejects a requiredness change even when the candidate declares the active version readable", () => {
    const candidate = atVersion(2, {
      compatibleReaderVersions: [1, 2],
      recordSchema: {
        fields: base.recordSchema.fields.map((field) =>
          field.key === "external_id" ? { ...field, required: false } : field,
        ),
      },
    });
    expect(findingCodes(candidate)).toContain("field_requirement_loosened");
  });
});

/**
 * The direction a one-sided matrix misses. A candidate that can read everything
 * already stored still writes records the release beside it has to read, and a
 * reader that never declared the candidate's version has not said it can.
 */
describe("evaluateStorageCompatibility candidate-writer coverage", () => {
  it("rejects a candidate whose records a surviving reader has not declared readable", () => {
    // The reader reads only [1]; the candidate writes version 2 and removes a
    // field, so the difference is not one an older reader can absorb structurally
    // and nothing else vouches for it either.
    const reader = buildStorageCollection({ schemaVersion: 1, compatibleReaderVersions: [1] });
    const candidate = atVersion(2, {
      compatibleReaderVersions: [1, 2],
      recordSchema: { fields: base.recordSchema.fields.filter((field) => field.key !== "sequence") },
    });

    expect(
      evaluate({ survivingReaders: [reader], candidate }).findings.map((finding) => finding.code),
    ).toContain("candidate_writer_unreadable");
  });

  it("accepts a candidate a surviving reader declares readable even at a higher version", () => {
    const reader = buildStorageCollection({ schemaVersion: 1, compatibleReaderVersions: [1, 2] });
    const candidate = atVersion(2);

    expect(evaluate({ survivingReaders: [reader], candidate }).compatible).toBe(true);
  });

  it("holds every surviving reader to the rule, not only the one still serving", () => {
    // A rollback release and a queued job's release both outlive the activation,
    // and one of them cannot read what the candidate is about to write.
    const serving = buildStorageCollection({ schemaVersion: 2, compatibleReaderVersions: [1, 2, 3] });
    const queued = buildStorageCollection({ schemaVersion: 1, compatibleReaderVersions: [1] });
    const candidate = atVersion(3, {
      recordSchema: { fields: base.recordSchema.fields.filter((field) => field.key !== "payload") },
    });

    const report = evaluate({ survivingReaders: [serving, queued], candidate });
    expect(report.findings.map((finding) => finding.code)).toContain("candidate_writer_unreadable");
  });
});

/**
 * A rollback is an activation whose candidate carries a lower schema version.
 * Lowering the number is not by itself a defect — what decides it is whether
 * every pairing still holds.
 */
describe("evaluateStorageCompatibility rollback", () => {
  it("accepts rolling back to a release that reads what is stored and what still serves", () => {
    const serving = atVersion(3);
    const candidate = atVersion(2, { compatibleReaderVersions: [1, 2, 3] });

    const report = evaluate({
      candidate,
      survivingReaders: [serving],
      storedWriterVersions: [2, 3],
    });
    expect(report).toEqual({ compatible: true, findings: [], requiresIndexRebuild: [] });
  });

  it("rejects rolling back to a release that cannot read what earlier releases stored", () => {
    const serving = atVersion(4);
    const candidate = buildStorageCollection({ schemaVersion: 2, compatibleReaderVersions: [1, 2] });

    const report = evaluate({ candidate, survivingReaders: [serving], storedWriterVersions: [3] });
    expect(report.findings.map((finding) => finding.code)).toContain("stored_writer_unreadable");
  });

  it("rejects rolling back past a field the later release added as required", () => {
    const serving = atVersion(3, {
      recordSchema: {
        fields: [...base.recordSchema.fields, { key: "etag", type: "string", required: true }],
      },
    });
    const candidate = atVersion(2, { compatibleReaderVersions: [1, 2, 3] });

    const report = evaluate({ candidate, survivingReaders: [serving] });
    expect(report.findings.map((finding) => finding.code)).toContain("required_field_added");
  });
});

describe("evaluateStorageCompatibility against stored and surviving readers", () => {
  it("accepts dropping an obsolete reader version no stored record uses", () => {
    // The contract caps the reader list, so a long-lived App has to drop the
    // oldest entry eventually; what makes that safe is that nothing carries it.
    const serving = atVersion(8);
    const candidate = buildStorageCollection({
      schemaVersion: 9,
      compatibleReaderVersions: [2, 3, 4, 5, 6, 7, 8, 9],
    });

    expect(
      evaluate({ candidate, survivingReaders: [serving], storedWriterVersions: [7, 8] }).compatible,
    ).toBe(true);
  });

  it("rejects dropping a reader version stored records still carry", () => {
    const serving = atVersion(8);
    const candidate = buildStorageCollection({
      schemaVersion: 9,
      compatibleReaderVersions: [2, 3, 4, 5, 6, 7, 8, 9],
    });

    expect(
      evaluate({ candidate, survivingReaders: [serving], storedWriterVersions: [1, 8] }).findings.map(
        (f) => f.code,
      ),
    ).toContain("stored_writer_unreadable");
  });

  it("charges each collection only with the versions its own rows carry", () => {
    // Collection A holds version 1 and collection B holds version 2. A flat list
    // of versions would make each answer for the other's history and reject a
    // candidate that is fine for both.
    const readsOne = buildStorageCollection({ id: "sync_state", compatibleReaderVersions: [1] });
    const readsTwo = buildStorageCollection({
      id: "cursors",
      schemaVersion: 2,
      compatibleReaderVersions: [2],
    });

    const report = evaluateStorageCompatibility({
      collections: [
        {
          collectionId: "sync_state",
          candidate: readsOne,
          survivingReaders: [readsOne],
          storedWriterVersions: [1],
        },
        {
          collectionId: "cursors",
          candidate: readsTwo,
          survivingReaders: [readsTwo],
          storedWriterVersions: [2],
        },
      ],
    });

    expect(report.compatible).toBe(true);
  });
});

describe("evaluateStorageCompatibility index rebuilds", () => {
  it("reports an added index as a rebuild the activation has to run first", () => {
    // Index entries exist per record, so the added index answers nothing about
    // records a surviving release wrote until it is built over them.
    const candidate = buildStorageCollection({
      indexes: [
        { id: "by_external_id", field: "external_id" },
        { id: "by_sequence", field: "sequence" },
      ],
    });

    const report = evaluate({ candidate });
    expect(report.compatible).toBe(true);
    expect(report.requiresIndexRebuild).toEqual([{ collectionId: "sync_state", indexId: "by_sequence" }]);
  });

  it("asks for no rebuild when every surviving reader already declares the index", () => {
    expect(evaluate({ candidate: buildStorageCollection() }).requiresIndexRebuild).toEqual([]);
  });

  it("names the collection and the declaration at fault without quoting stored data", () => {
    const [finding] = evaluate({ candidate: buildStorageCollection({ indexes: [] }) }).findings;
    expect(finding?.collectionId).toBe("sync_state");
    expect(finding?.detail).toContain("by_external_id");
  });
});
