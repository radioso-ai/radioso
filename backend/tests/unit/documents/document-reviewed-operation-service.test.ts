import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { DocumentReviewedOperationService } from "../../../src/modules/documents/services/documentReviewedOperationService.js";
import { conflict } from "../../../src/shared/domain/errors.js";

const workspaceId = "workspace-1";

describe("DocumentReviewedOperationService", () => {
  it("plans unchanged external ids without consuming a stored-document slot", async () => {
    const service = new DocumentReviewedOperationService(
      {
        findActivePageState: vi.fn(async () => ({ documentId: randomUUID(), revision: 1, contentSizeBytes: 8, contentHash: "e4f7b27f1478ca3d1b1fc2c6a268b6f4b1c2b23a1d07fd30d7b23430cfe3ea23" })),
        findPageState: vi.fn(async () => ({ documentId: randomUUID(), revision: 1, contentSizeBytes: 8, contentHash: "e4f7b27f1478ca3d1b1fc2c6a268b6f4b1c2b23a1d07fd30d7b23430cfe3ea23" })),
        listSummariesByIdsAndWorkspaceId: vi.fn(),
        findByExternalDocumentId: vi.fn(), findBySourceAndExternalDocumentId: vi.fn(), countReprocessCandidates: vi.fn(), listSummaryPageByWorkspaceId: vi.fn(), listSummaryPageBySourceId: vi.fn(),
      },
      { ingest: vi.fn() } as never,
      { delete: vi.fn() },
      { getDocumentCapacityUsage: vi.fn(async () => ({ storedDocuments: { used: 100, limit: 100 }, storedIndexedBytes: { used: 0, limit: null }, monthlyIndexedBytes: { used: 0, limit: null } })) },
    );

    const plan = await service.prepareImport({
      workspaceId,
      accountId: "account-1",
      sourceId: null,
      documents: [{ externalDocumentId: "constitution-1", title: "Constitution", content: "Article 1" }],
    });

    expect(plan.documents[0]?.action).toBe("replace");
  });

  it("refuses a batch before writes when new documents exceed stored-document headroom", async () => {
    const ingest = vi.fn();
    const service = new DocumentReviewedOperationService(
      { findActivePageState: vi.fn(async () => null), findPageState: vi.fn(async () => null), listSummariesByIdsAndWorkspaceId: vi.fn(), findByExternalDocumentId: vi.fn(), findBySourceAndExternalDocumentId: vi.fn(), countReprocessCandidates: vi.fn(), listSummaryPageByWorkspaceId: vi.fn(), listSummaryPageBySourceId: vi.fn() },
      { ingest } as never,
      { delete: vi.fn() },
      { getDocumentCapacityUsage: vi.fn(async () => ({ storedDocuments: { used: 100, limit: 100 }, storedIndexedBytes: { used: 0, limit: null }, monthlyIndexedBytes: { used: 0, limit: null } })) },
    );

    await expect(service.prepareImport({
      workspaceId,
      accountId: "account-1",
      sourceId: null,
      documents: [{ externalDocumentId: "constitution-101", title: "Article", content: "Text" }],
    })).rejects.toMatchObject({ code: "bad_request", message: "Import would exceed stored_documents: limit 100, current 100, requested new 1." });
    expect(ingest).not.toHaveBeenCalled();
  });

  it("reports a concurrent document update as changed instead of deleting it", async () => {
    const deletion = { delete: vi.fn(async () => { throw conflict("moved"); }) };
    const service = new DocumentReviewedOperationService(
      { findActivePageState: vi.fn(), findPageState: vi.fn(), listSummariesByIdsAndWorkspaceId: vi.fn(), findByExternalDocumentId: vi.fn(), findBySourceAndExternalDocumentId: vi.fn(), countReprocessCandidates: vi.fn(), listSummaryPageByWorkspaceId: vi.fn(), listSummaryPageBySourceId: vi.fn() },
      { ingest: vi.fn() } as never,
      deletion,
      { getDocumentCapacityUsage: vi.fn() },
    );

    const result = await service.remove({ workspaceId, documents: [{ id: "document-1", updatedAt: "2026-09-26T00:00:00.000Z" }] });

    expect(result.counts).toEqual({ removed: 0, changed: 1, alreadyRemoved: 0, failed: 0 });
  });

  it("refuses an empty reviewed reprocess selector before a proposal can be written", async () => {
    const service = new DocumentReviewedOperationService(
      { findActivePageState: vi.fn(), findPageState: vi.fn(), listSummariesByIdsAndWorkspaceId: vi.fn(async () => []), findByExternalDocumentId: vi.fn(), findBySourceAndExternalDocumentId: vi.fn(), countReprocessCandidates: vi.fn(), listSummaryPageByWorkspaceId: vi.fn(), listSummaryPageBySourceId: vi.fn() },
      { ingest: vi.fn() } as never, { delete: vi.fn() }, { getDocumentCapacityUsage: vi.fn() },
    );
    await expect(service.prepareReprocess({ workspaceId, kind: "documents", documentIds: ["missing"] })).rejects.toMatchObject({ code: "bad_request" });
  });

  it("plans a failed external id as a guarded replacement rather than a new document", async () => {
    const service = new DocumentReviewedOperationService(
      { findActivePageState: vi.fn(async () => null), findPageState: vi.fn(async () => ({ documentId: randomUUID(), revision: 4, contentSizeBytes: 3, contentHash: "old" })), listSummariesByIdsAndWorkspaceId: vi.fn(), findByExternalDocumentId: vi.fn(), findBySourceAndExternalDocumentId: vi.fn(), countReprocessCandidates: vi.fn(), listSummaryPageByWorkspaceId: vi.fn(), listSummaryPageBySourceId: vi.fn() },
      { ingest: vi.fn() } as never, { delete: vi.fn() },
      { getDocumentCapacityUsage: vi.fn(async () => ({ storedDocuments: { used: 1, limit: 1 }, storedIndexedBytes: { used: 0, limit: null }, monthlyIndexedBytes: { used: 0, limit: null } })) },
    );
    const plan = await service.prepareImport({ workspaceId, accountId: "account-1", sourceId: null, documents: [{ externalDocumentId: "failed", title: "Failed", content: "new" }] });
    expect(plan.documents[0]).toMatchObject({ action: "replace", expectedRevision: 4 });
  });

  it("keeps a freshly prepared failed-row import fence current", async () => {
    const state = { documentId: randomUUID(), revision: 4, contentSizeBytes: 3, contentHash: "old" };
    const service = new DocumentReviewedOperationService(
      { findActivePageState: vi.fn(async () => null), findPageState: vi.fn(async () => state), listSummariesByIdsAndWorkspaceId: vi.fn(), findByExternalDocumentId: vi.fn(), findBySourceAndExternalDocumentId: vi.fn(), countReprocessCandidates: vi.fn(), listSummaryPageByWorkspaceId: vi.fn(), listSummaryPageBySourceId: vi.fn() },
      { ingest: vi.fn() } as never, { delete: vi.fn() },
      { getDocumentCapacityUsage: vi.fn(async () => ({ storedDocuments: { used: 1, limit: null }, storedIndexedBytes: { used: 0, limit: null }, monthlyIndexedBytes: { used: 0, limit: null } })) },
    );
    const plan = await service.prepareImport({ workspaceId, accountId: "account-1", sourceId: null, documents: [{ externalDocumentId: "failed", title: "Failed", content: "new" }] });

    await expect(service.readReviewedPlanFence({ workspaceId, targetRef: { sourceId: null }, plan }))
      .resolves.toBe(plan.fence);
  });

  it("refuses a removal plan with no resolved documents", async () => {
    const service = new DocumentReviewedOperationService(
      { findActivePageState: vi.fn(), findPageState: vi.fn(), listSummariesByIdsAndWorkspaceId: vi.fn(async () => []), findByExternalDocumentId: vi.fn(), findBySourceAndExternalDocumentId: vi.fn(), countReprocessCandidates: vi.fn(), listSummaryPageByWorkspaceId: vi.fn(), listSummaryPageBySourceId: vi.fn() },
      { ingest: vi.fn() } as never, { delete: vi.fn() }, { getDocumentCapacityUsage: vi.fn() },
    );
    await expect(service.prepareRemoval({ workspaceId, documentIds: ["missing"], externalDocumentIds: [], sourceId: null })).rejects.toMatchObject({ code: "bad_request" });
  });

  /**
   * `prepareImport`'s only caller today (the MCP tool) already bounds its own input to 100
   * documents, so this limit is not reachable through that path. It still has to hold as an
   * owner-level invariant with a caller refusal, not a raw parse error, because the persisted
   * plan schema is the one contract every caller of this owner method shares.
   */
  it("refuses an import plan over the owner's document limit with a caller refusal, not a raw parse error", async () => {
    const service = new DocumentReviewedOperationService(
      { findActivePageState: vi.fn(async () => null), findPageState: vi.fn(async () => null), listSummariesByIdsAndWorkspaceId: vi.fn(), findByExternalDocumentId: vi.fn(), findBySourceAndExternalDocumentId: vi.fn(), countReprocessCandidates: vi.fn(), listSummaryPageByWorkspaceId: vi.fn(), listSummaryPageBySourceId: vi.fn() },
      { ingest: vi.fn() } as never, { delete: vi.fn() },
      { getDocumentCapacityUsage: vi.fn(async () => ({ storedDocuments: { used: 0, limit: null }, storedIndexedBytes: { used: 0, limit: null }, monthlyIndexedBytes: { used: 0, limit: null } })) },
    );
    const documents = Array.from({ length: 101 }, (_, index) => ({ externalDocumentId: `doc-${index}`, title: "Doc", content: "x" }));

    await expect(service.prepareImport({ workspaceId, accountId: "account-1", sourceId: null, documents }))
      .rejects.toMatchObject({ code: "bad_request" });
  });
});
