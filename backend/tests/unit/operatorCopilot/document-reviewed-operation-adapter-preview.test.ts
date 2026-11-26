import { describe, expect, it } from "vitest";

import { createDocumentReviewedOperationAdapter } from "../../../src/modules/operatorCopilot/documentReviewedOperationAdapter.js";

const adapter = createDocumentReviewedOperationAdapter({ operations: {} as never });
const id = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const updatedAt = "2026-11-01T00:00:00.000Z";
const hash = "a".repeat(64);

describe("document reviewed operation preview", () => {
  it("lists one row per document for a removal, even when titles collide", async () => {
    const preview = await adapter.preview("workspace-1", { sourceId: null }, {
      operation: "removal", fence: "f", unknownIds: [],
      documents: [
        { id: id(1), title: "Returns policy", updatedAt }, { id: id(2), title: "Returns policy", updatedAt },
        { id: id(3), title: "Returns policy (00000001)", updatedAt }, { id: id(4), title: "Shipping", updatedAt },
      ],
    });
    expect(preview.targetLabel).toBe("Remove 4 documents");
    const rows = Object.keys(preview.current as object);
    expect(rows).toHaveLength(4);
    expect(rows).toContain("Shipping");
    expect(rows.filter((row) => row.startsWith("Returns policy"))).toHaveLength(3);
    expect(preview.proposed).toEqual({});
  });

  it("shows what each imported document becomes", async () => {
    const preview = await adapter.preview("workspace-1", { sourceId: null }, {
      operation: "import", fence: "f",
      documents: [{ externalDocumentId: "a", title: "FAQ", content: "x", contentHash: hash, expectedDocumentId: null, expectedRevision: null, expectedContentHash: null, indexedBytes: 1, storageDeltaBytes: 1, action: "create" }],
    });
    expect(preview).toMatchObject({ targetLabel: "Import 1 document", current: null, proposed: { FAQ: "create" } });
  });

  it("names the documents a reprocess queues again", async () => {
    const preview = await adapter.preview("workspace-1", { sourceId: null }, {
      operation: "reprocess", fence: "f", documents: [{ id: id(1), title: "FAQ", updatedAt, status: "failed" }],
    });
    expect(preview).toMatchObject({ targetLabel: "Reprocess 1 document", current: { FAQ: "failed" }, proposed: { FAQ: "Queued again" } });
  });
});
