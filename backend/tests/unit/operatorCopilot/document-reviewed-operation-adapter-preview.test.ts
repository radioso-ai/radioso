import { describe, expect, it } from "vitest";

import { createDocumentReviewedOperationAdapter } from "../../../src/modules/operatorCopilot/documentReviewedOperationAdapter.js";

const adapter = createDocumentReviewedOperationAdapter({ operations: {} as never });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const updatedAt = "2026-11-01T00:00:00.000Z";
const hash = "a".repeat(64);

describe("document reviewed operation preview", () => {
  it("lists the titles of the documents a removal deletes, with nothing proposed in their place", async () => {
    const preview = await adapter.preview("workspace-1", { sourceId: null }, {
      operation: "removal", fence: "f", unknownIds: [],
      documents: [{ id: id(1), title: "Returns policy", updatedAt }, { id: id(2), title: "Returns policy", updatedAt }, { id: id(3), title: "Shipping", updatedAt }],
    });
    expect(preview.targetLabel).toBe("Remove 3 documents");
    expect(preview.current).toEqual({ "Returns policy": "Stored", "Returns policy (2)": "Stored", Shipping: "Stored" });
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
