import { describe, expect, it } from "vitest";
import { syncDocuments } from "../src/import/sync.ts";
import type { DocumentInput } from "../src/import/buildDocuments.ts";
import type { ExistingDocument, RadiosoDocsClient } from "../src/radioso/client.ts";

function doc(externalDocumentId: string): DocumentInput {
  return {
    externalDocumentId,
    title: externalDocumentId,
    content: "body",
    source: { kind: "website", url: "https://docs.radioso.dev/x" },
    metadata: { section: "mdx-docs", slug: "x", docsUrl: "https://docs.radioso.dev/x" },
  };
}

function fakeClient(existing: ExistingDocument[]) {
  const created: string[] = [];
  const deleted: string[] = [];
  const client: RadiosoDocsClient = {
    listAll: async () => existing,
    create: async (input) => {
      created.push(input.externalDocumentId);
      return { documentId: `id-${input.externalDocumentId}`, status: "processing" };
    },
    delete: async (id) => {
      deleted.push(id);
    },
  };
  return { client, created, deleted };
}

describe("syncDocuments", () => {
  it("upserts every desired document", async () => {
    const { client, created } = fakeClient([]);
    const report = await syncDocuments(client, [doc("mdx-docs:a"), doc("mdx-docs:b")], {
      prune: false,
      pruneSections: new Set(["mdx-docs"]),
    });
    expect(created).toEqual(["mdx-docs:a", "mdx-docs:b"]);
    expect(report.upserted).toBe(2);
    expect(report.pruned).toBe(0);
  });

  it("prunes only owned documents that are no longer desired", async () => {
    const existing: ExistingDocument[] = [
      { id: "keep", externalDocumentId: "mdx-docs:a", metadata: { section: "mdx-docs" } },
      { id: "stale", externalDocumentId: "mdx-docs:gone", metadata: { section: "mdx-docs" } },
      { id: "api-stale", externalDocumentId: "api-reference:Old", metadata: { section: "api-reference" } },
    ];
    const { client, deleted } = fakeClient(existing);
    const report = await syncDocuments(client, [doc("mdx-docs:a")], {
      prune: true,
      pruneSections: new Set(["mdx-docs", "api-reference"]),
    });
    expect(deleted.sort()).toEqual(["api-stale", "stale"]);
    expect(report.pruned).toBe(2);
  });

  it("never prunes sections that were not part of this import", async () => {
    // Simulates `--no-api --prune`: only mdx-docs were built, so api-reference
    // documents must be left untouched rather than wiped.
    const existing: ExistingDocument[] = [
      { id: "stale-mdx", externalDocumentId: "mdx-docs:gone", metadata: { section: "mdx-docs" } },
      { id: "api-keep", externalDocumentId: "api-reference:Documents", metadata: { section: "api-reference" } },
    ];
    const { client, deleted } = fakeClient(existing);
    const report = await syncDocuments(client, [doc("mdx-docs:a")], {
      prune: true,
      pruneSections: new Set(["mdx-docs"]),
    });
    expect(deleted).toEqual(["stale-mdx"]);
    expect(report.pruned).toBe(1);
  });

  it("never prunes documents the importer does not own", async () => {
    const existing: ExistingDocument[] = [
      { id: "user-doc", externalDocumentId: "something-else", metadata: { section: "user-upload" } },
      { id: "no-meta", externalDocumentId: null, metadata: null },
    ];
    const { client, deleted } = fakeClient(existing);
    await syncDocuments(client, [], { prune: true, pruneSections: new Set(["mdx-docs", "api-reference"]) });
    expect(deleted).toEqual([]);
  });

  it("does not prune when prune is disabled", async () => {
    const existing: ExistingDocument[] = [
      { id: "stale", externalDocumentId: "mdx-docs:gone", metadata: { section: "mdx-docs" } },
    ];
    const { client, deleted } = fakeClient(existing);
    await syncDocuments(client, [], { prune: false, pruneSections: new Set(["mdx-docs"]) });
    expect(deleted).toEqual([]);
  });
});
