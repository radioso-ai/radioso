import { describe, expect, it } from "vitest";
import { syncDocuments } from "../src/import/sync.ts";
import type { DocumentInput } from "../src/import/buildDocuments.ts";
import type { ExistingDocument, RadiosoDocsClient } from "../src/radioso/client.ts";

function doc(externalDocumentId: string): DocumentInput {
  return {
    externalDocumentId,
    title: externalDocumentId,
    content: "body",
    source: { kind: "website", url: "https://docs.radioso.dev" },
    metadata: { section: "mdx-docs", slug: "x", url: "https://docs.radioso.dev/x" },
  };
}

function fakeClient(existing: ExistingDocument[]) {
  const state = [...existing];
  const created: string[] = [];
  const deleted: string[] = [];
  const deletedSources: string[] = [];
  const events: string[] = [];
  let calls = 0;
  const client: RadiosoDocsClient = {
    listAll: async () => {
      calls += 1;
      events.push("list");
      return [...state];
    },
    create: async (input) => {
      created.push(input.externalDocumentId);
      events.push(`create:${input.externalDocumentId}`);
      const existingCommon = state.find(
        (document) => document.externalDocumentId === input.externalDocumentId && document.sourceId === "source-common",
      );
      if (!existingCommon) {
        state.push({
          id: `id-${input.externalDocumentId}`,
          externalDocumentId: input.externalDocumentId,
          sourceId: "source-common",
          metadata: input.metadata,
        });
      }
      return { documentId: `id-${input.externalDocumentId}`, status: "processing" };
    },
    delete: async (id) => {
      deleted.push(id);
      events.push(`delete:${id}`);
      const index = state.findIndex((document) => document.id === id);
      if (index !== -1) {
        state.splice(index, 1);
      }
    },
    deleteSource: async (id) => {
      deletedSources.push(id);
      events.push(`deleteSource:${id}`);
    },
  };
  return { client, created, deleted, deletedSources, events, calls: () => calls };
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
      { id: "keep", externalDocumentId: "mdx-docs:a", sourceId: "source-common", metadata: { section: "mdx-docs" } },
      { id: "stale", externalDocumentId: "mdx-docs:gone", sourceId: "source-old", metadata: { section: "mdx-docs" } },
      {
        id: "api-stale",
        externalDocumentId: "api-reference:Old",
        sourceId: "source-api",
        metadata: { section: "api-reference" },
      },
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
      { id: "stale-mdx", externalDocumentId: "mdx-docs:gone", sourceId: "source-old", metadata: { section: "mdx-docs" } },
      {
        id: "api-keep",
        externalDocumentId: "api-reference:Documents",
        sourceId: "source-api",
        metadata: { section: "api-reference" },
      },
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
      { id: "user-doc", externalDocumentId: "something-else", sourceId: "source-user", metadata: { section: "user-upload" } },
      { id: "no-meta", externalDocumentId: null, sourceId: null, metadata: null },
    ];
    const { client, deleted } = fakeClient(existing);
    await syncDocuments(client, [], { prune: true, pruneSections: new Set(["mdx-docs", "api-reference"]) });
    expect(deleted).toEqual([]);
  });

  it("does not prune when prune is disabled", async () => {
    const existing: ExistingDocument[] = [
      { id: "stale", externalDocumentId: "mdx-docs:gone", sourceId: "source-old", metadata: { section: "mdx-docs" } },
    ];
    const { client, deleted } = fakeClient(existing);
    await syncDocuments(client, [], { prune: false, pruneSections: new Set(["mdx-docs"]) });
    expect(deleted).toEqual([]);
  });

  it("prunes owned docs outside the common source and deletes legacy sources except the manual source", async () => {
    const manualSourceId = "00000000-0000-0000-0000-000000000001";
    const existing: ExistingDocument[] = [
      { id: "keep", externalDocumentId: "mdx-docs:a", sourceId: "source-common", metadata: { section: "mdx-docs" } },
      {
        id: "legacy-desired",
        externalDocumentId: "mdx-docs:b",
        sourceId: "source-legacy",
        metadata: { section: "mdx-docs" },
      },
      { id: "gone", externalDocumentId: "mdx-docs:gone", sourceId: "source-gone", metadata: { section: "mdx-docs" } },
      {
        id: "manual",
        externalDocumentId: "mdx-docs:manual",
        sourceId: manualSourceId,
        metadata: { section: "mdx-docs" },
      },
      { id: "other", externalDocumentId: "user-doc", sourceId: "source-user", metadata: { section: "user-upload" } },
    ];
    const { client, deleted, deletedSources } = fakeClient(existing);

    const report = await syncDocuments(client, [doc("mdx-docs:a"), doc("mdx-docs:b")], {
      prune: true,
      pruneSections: new Set(["mdx-docs"]),
    });

    expect(deleted.sort()).toEqual(["gone", "legacy-desired", "manual"]);
    expect(deletedSources.sort()).toEqual(["source-gone", "source-legacy"]);
    expect(report.prunedIds.sort()).toEqual(["gone", "legacy-desired", "manual"]);
    expect(report.prunedSourceIds.sort()).toEqual(["source-gone", "source-legacy"]);
  });

  it("identifies the common source from the created document, not list order", async () => {
    // Migration window: each externalDocumentId still has a legacy duplicate. The
    // legacy row is listed FIRST, so picking the common source by list order would
    // wrongly select the legacy source and then delete the freshly-upserted doc and
    // the real common source. Resolution must key off the importer's created id.
    const existing: ExistingDocument[] = [
      { id: "legacy-a", externalDocumentId: "mdx-docs:a", sourceId: "source-legacy", metadata: { section: "mdx-docs" } },
      {
        id: "id-mdx-docs:a",
        externalDocumentId: "mdx-docs:a",
        sourceId: "source-common",
        metadata: { section: "mdx-docs" },
      },
    ];
    const { client, deleted, deletedSources } = fakeClient(existing);

    const report = await syncDocuments(client, [doc("mdx-docs:a")], {
      prune: true,
      pruneSections: new Set(["mdx-docs"]),
    });

    expect(deleted).toEqual(["legacy-a"]);
    expect(deletedSources).toEqual(["source-legacy"]);
    expect(report.prunedSourceIds).toEqual(["source-legacy"]);
  });

  it("never deletes a legacy source that still holds a document the importer does not own", async () => {
    // A user/API document happens to share the old importer source URL. We prune our
    // owned doc from that source but must NOT delete the source, because the backend
    // cascade would destroy the unrelated document too.
    const existing: ExistingDocument[] = [
      { id: "owned", externalDocumentId: "mdx-docs:gone", sourceId: "source-shared", metadata: { section: "mdx-docs" } },
      { id: "user-doc", externalDocumentId: "user-thing", sourceId: "source-shared", metadata: { section: "user-upload" } },
      { id: "common", externalDocumentId: "mdx-docs:a", sourceId: "source-common", metadata: { section: "mdx-docs" } },
    ];
    const { client, deleted, deletedSources } = fakeClient(existing);

    const report = await syncDocuments(client, [doc("mdx-docs:a")], {
      prune: true,
      pruneSections: new Set(["mdx-docs"]),
    });

    // Our owned doc is pruned, the unrelated user doc is left alone, and the shared
    // source is preserved rather than cascade-deleted.
    expect(deleted).toEqual(["owned"]);
    expect(deletedSources).toEqual([]);
    expect(report.prunedSourceIds).toEqual([]);
  });

  it("prunes each legacy duplicate immediately after its common-source upsert", async () => {
    const existing: ExistingDocument[] = [
      { id: "legacy-a", externalDocumentId: "mdx-docs:a", sourceId: "source-a", metadata: { section: "mdx-docs" } },
      { id: "legacy-b", externalDocumentId: "mdx-docs:b", sourceId: "source-b", metadata: { section: "mdx-docs" } },
    ];
    const { client, events, deleted } = fakeClient(existing);

    await syncDocuments(client, [doc("mdx-docs:a"), doc("mdx-docs:b")], {
      prune: true,
      pruneSections: new Set(["mdx-docs"]),
    });

    expect(deleted).toEqual(["legacy-a", "legacy-b"]);
    expect(events).toEqual([
      "list",
      "create:mdx-docs:a",
      "list",
      "delete:legacy-a",
      "deleteSource:source-a",
      "create:mdx-docs:b",
      "list",
      "delete:legacy-b",
      "deleteSource:source-b",
      "list",
    ]);
  });

  it("prunes stale docs before uploading to make room under document quotas", async () => {
    const existing: ExistingDocument[] = [
      { id: "stale", externalDocumentId: "mdx-docs:gone", sourceId: "source-stale", metadata: { section: "mdx-docs" } },
    ];
    const { client, events } = fakeClient(existing);

    await syncDocuments(client, [doc("mdx-docs:a")], {
      prune: true,
      pruneSections: new Set(["mdx-docs"]),
    });

    expect(events.slice(0, 3)).toEqual(["list", "delete:stale", "deleteSource:source-stale"]);
    expect(events).toContain("create:mdx-docs:a");
  });
});
