import { describe, expect, it, vi } from "vitest";

import {
  ContentPlanningCorpusEvidenceService,
  type ContentPlanningCorpusEvidenceStorePort,
  type ContentPlanningCorpusSearchPort,
} from "../../src/modules/contentPlanning/services/corpusEvidenceService.js";

describe("ContentPlanningCorpusEvidenceService", () => {
  it("persists only the top five authorized documents above the relevance floor with timing/use evidence", async () => {
    const search: ContentPlanningCorpusSearchPort = {
      findRelatedDocuments: vi.fn(async () => [
        ...Array.from({ length: 6 }, (_, index) => ({
          id: `document_${index + 1}`,
          title: `Document ${index + 1}`,
          possibleRelevance: 0.95 - (index * 0.03),
          createdAt: index === 0 ? "2026-07-15T00:00:00.000Z" : "2026-06-01T00:00:00.000Z",
          updatedAt: index === 1 ? "2026-07-20T00:00:00.000Z" : "2026-06-10T00:00:00.000Z",
        })),
        {
          id: "below_floor",
          title: "Below floor",
          possibleRelevance: 0.73,
          createdAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-06-01T00:00:00.000Z",
        },
      ]),
    };
    const store: ContentPlanningCorpusEvidenceStorePort = {
      replaceTopicDocuments: vi.fn(async () => {}),
      invalidateDocument: vi.fn(async () => 0),
    };
    const service = new ContentPlanningCorpusEvidenceService({ search, store });

    const result = await service.refresh({
      workspaceId: "workspace_1",
      generationId: "generation_1",
      topicId: "topic_1",
      sourceTopicRevision: 3,
      embeddingSpaceId: "space_1",
      centroid: [0.1, 0.2],
      earliestActiveGapAt: "2026-07-01T00:00:00.000Z",
      retrievedDocumentIds: ["document_1"],
      citedDocumentIds: ["document_2"],
    });

    expect(result.state).toBe("ready");
    expect(result.documents).toHaveLength(5);
    expect(result.documents[0]).toMatchObject({
      id: "document_1",
      evidence: {
        existedBeforeGap: false,
        retrievedByGapAnswers: true,
        citedByGapAnswers: false,
        changedAfterGap: false,
      },
    });
    expect(result.documents[1]).toMatchObject({
      id: "document_2",
      evidence: {
        existedBeforeGap: true,
        retrievedByGapAnswers: false,
        citedByGapAnswers: true,
        changedAfterGap: true,
      },
    });
    expect(result.documents.map((document) => document.id)).not.toContain("below_floor");
    expect(store.replaceTopicDocuments).toHaveBeenCalledWith(expect.objectContaining({
      sourceTopicRevision: 3,
      documents: result.documents,
    }));
  });

  it("removes stale links when authorized search no longer returns a deleted document", async () => {
    const search: ContentPlanningCorpusSearchPort = {
      findRelatedDocuments: vi.fn(async () => []),
    };
    const store: ContentPlanningCorpusEvidenceStorePort = {
      replaceTopicDocuments: vi.fn(async () => {}),
      invalidateDocument: vi.fn(async () => 1),
    };
    const service = new ContentPlanningCorpusEvidenceService({ search, store });

    const result = await service.refresh({
      workspaceId: "workspace_1",
      generationId: "generation_1",
      topicId: "topic_1",
      sourceTopicRevision: 4,
      embeddingSpaceId: "space_1",
      centroid: [1, 0],
      earliestActiveGapAt: null,
      retrievedDocumentIds: [],
      citedDocumentIds: [],
    });
    expect(result).toEqual({ state: "ready", documents: [] });
    expect(store.replaceTopicDocuments).toHaveBeenCalledWith(expect.objectContaining({ documents: [] }));

    await expect(service.invalidateDeletedDocument("workspace_1", "deleted_document"))
      .resolves.toBe(1);
    expect(store.invalidateDocument).toHaveBeenCalledWith("workspace_1", "deleted_document");
  });

  it("reports corpus unavailability without retaining candidates or claiming completeness", async () => {
    const search: ContentPlanningCorpusSearchPort = {
      findRelatedDocuments: vi.fn(async () => { throw new Error("document content and provider details"); }),
    };
    const store: ContentPlanningCorpusEvidenceStorePort = {
      replaceTopicDocuments: vi.fn(async () => {}),
      invalidateDocument: vi.fn(async () => 0),
    };
    const service = new ContentPlanningCorpusEvidenceService({ search, store });

    const result = await service.refresh({
      workspaceId: "workspace_1",
      generationId: "generation_1",
      topicId: "topic_1",
      sourceTopicRevision: 1,
      embeddingSpaceId: "space_1",
      centroid: [1, 0],
      earliestActiveGapAt: null,
      retrievedDocumentIds: [],
      citedDocumentIds: [],
    });

    expect(result).toEqual({ state: "unavailable", documents: [] });
    expect(JSON.stringify(result)).not.toContain("provider details");
    expect(store.replaceTopicDocuments).not.toHaveBeenCalled();
  });
});
