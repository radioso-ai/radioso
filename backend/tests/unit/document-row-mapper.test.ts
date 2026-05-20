import { describe, expect, it } from "vitest";

import { mapDocumentSummary, type DocumentRow } from "../../src/db/repositories/documentRowMapper.js";

const baseRow = (): DocumentRow => ({
  id: "doc-1",
  workspace_id: "workspace-1",
  title: "Doc",
  source_content: "",
  markdown_content: "",
  source_id: null,
  source: null,
  external_document_id: null,
  status: "ready",
  revision: 1,
  failure_reason: null,
  created_at: new Date("2026-05-20T00:00:00Z"),
  updated_at: new Date("2026-05-20T00:00:00Z"),
  metadata: {},
  source_kind: "inline_text",
  source_filename: null,
  source_mime_type: null,
  source_storage_bucket: null,
  source_storage_object: null,
  source_storage_generation: null,
  source_size_bytes: null,
  content_size_bytes: null,
  content_hash: null,
});

describe("mapDocumentSummary", () => {
  it("coerces BIGINT byte columns that arrive from pg as strings", () => {
    const row: DocumentRow = {
      ...baseRow(),
      content_size_bytes: "12345",
      content_size: "12345",
      source_size_bytes: "12345",
    };

    const summary = mapDocumentSummary(row);

    expect(summary.contentSize).toBe(12345);
    expect(summary.contentSizeBytes).toBe(12345);
    expect(summary.sourceSizeBytes).toBe(12345);
  });

  it("returns null when no size column is populated", () => {
    const summary = mapDocumentSummary(baseRow());

    expect(summary.contentSize).toBeNull();
    expect(summary.contentSizeBytes).toBeNull();
    expect(summary.sourceSizeBytes).toBeNull();
  });
});
