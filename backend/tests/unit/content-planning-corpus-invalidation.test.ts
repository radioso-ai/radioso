import { describe, expect, it, vi } from "vitest";

import { ContentPlanningDocumentCorpusObserver } from "../../src/app/composition/adapters/contentPlanningDocumentCorpusObserver.js";
import { ContentPlanCorpusInvalidationFanout } from "../../src/modules/contentPlanning/services/corpusInvalidation.js";

const DIRTY_AT = new Date("2026-08-02T12:00:00.000Z");

describe("content planning corpus invalidation", () => {
  it("uses the same constant-time workspace marker for publication and deletion", async () => {
    const invalidations = {
      markWorkspaceDirty: vi.fn(async () => undefined),
    };
    const observer = new ContentPlanningDocumentCorpusObserver(invalidations, () => DIRTY_AT);

    for (let document = 0; document < 20; document += 1) {
      await observer.onCorpusChanged({
        workspaceId: "workspace_1",
        documentId: `document_published_${document}`,
        change: "published",
      });
    }
    await observer.onCorpusChanged({
      workspaceId: "workspace_1",
      documentId: "document_deleted",
      change: "deleted",
    });
    await observer.onCorpusChanged({ workspaceId: "workspace_1", change: "deleted" });

    expect(invalidations.markWorkspaceDirty).toHaveBeenCalledTimes(22);
    expect(invalidations.markWorkspaceDirty).toHaveBeenNthCalledWith(1, {
      workspaceId: "workspace_1",
      dirtyAt: DIRTY_AT,
    });
    expect(invalidations.markWorkspaceDirty).toHaveBeenNthCalledWith(22, {
      workspaceId: "workspace_1",
      dirtyAt: DIRTY_AT,
    });
  });

  it("records bounded fanout outcomes without document or topic content", async () => {
    const record = vi.fn();
    const fanout = new ContentPlanCorpusInvalidationFanout({
      drainWorkspace: vi.fn(async () => ({
        invalidatedCount: 3,
        pending: true,
        markerRevision: "7",
      })),
    }, { record });

    await expect(fanout.runOnce({ workspaceId: "workspace_1", limit: 3 }))
      .resolves.toMatchObject({ invalidatedCount: 3, pending: true });
    expect(record).toHaveBeenCalledWith({
      stage: "corpus_invalidation",
      outcome: "completed",
      workspaceId: "workspace_1",
      itemCount: 3,
      durationMs: expect.any(Number),
    });
    expect(JSON.stringify(record.mock.calls)).not.toContain("document");
    expect(JSON.stringify(record.mock.calls)).not.toContain("topic");
  });
});
