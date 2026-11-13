import { createNoopWorkspaceInvalidationPublisher } from "@radioso/workspace-invalidation-contract";
import { describe, expect, it, vi } from "vitest";

import { DocumentIngestionService } from "../../../src/modules/documents/services/documentIngestionService.js";
import type { DocumentImageCandidatesPort } from "../../../src/modules/documents/services/documentImageCaptureQueue.js";
import { createAuditService, InMemoryDocumentRepository } from "../../support/fakes.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const PAGE = "The guide walks through every meadow above the tree line.\n\nEdelweiss grows on limestone ledges.";

const setup = () => {
  const recordCandidates = vi.fn<DocumentImageCandidatesPort["recordCandidates"]>().mockResolvedValue(undefined);
  const service = new DocumentIngestionService(
    new InMemoryDocumentRepository(),
    createAuditService(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    createNoopWorkspaceInvalidationPublisher(),
    { recordCandidates },
  );
  return { service, recordCandidates };
};

const page = {
  workspaceId: WORKSPACE_ID,
  title: "Alpine Flowers",
  content: PAGE,
  externalDocumentId: "website:https://shop.example/books/alpine",
};

describe("document ingestion with the images its content names", () => {
  it("records a new revision's images, placed in the stored text, before its job runs", async () => {
    const { service, recordCandidates } = setup();

    const { documentId } = await service.ingest({
      ...page,
      images: [
        { sourceUrl: "https://cdn.shop.example/ridge.jpg", role: "inline", alt: "Ridge", textOffset: PAGE.indexOf("Edelweiss") },
        { sourceUrl: "https://cdn.shop.example/cover.jpg", role: "primary" },
        { sourceUrl: "javascript:alert(1)", role: "primary" },
      ],
    });

    expect(recordCandidates).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      documentId,
      revision: 1,
      published: false,
      images: [
        { sourceUrl: "https://cdn.shop.example/cover.jpg", role: "primary", alt: "", caption: null, position: 0, textOffset: null },
        { sourceUrl: "https://cdn.shop.example/ridge.jpg", role: "inline", alt: "Ridge", caption: null, position: 1, textOffset: expect.any(Number) },
      ],
    });
  });

  it("records the images of a page whose text did not change against the revision already published", async () => {
    const { service, recordCandidates } = setup();
    const { documentId } = await service.ingest({ ...page, images: [] });

    await service.ingest({ ...page, images: [{ sourceUrl: "https://cdn.shop.example/cover.jpg", role: "primary" }] });

    expect(recordCandidates).toHaveBeenLastCalledWith(expect.objectContaining({ documentId, revision: 1, published: true }));
  });

  it("leaves a document's images alone when its source says nothing about images", async () => {
    const { service, recordCandidates } = setup();

    await service.ingest(page);

    expect(recordCandidates).not.toHaveBeenCalled();
  });
});
