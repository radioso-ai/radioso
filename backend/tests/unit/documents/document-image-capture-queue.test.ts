import { describe, expect, it, vi } from "vitest";

import { DocumentImageCaptureQueue } from "../../../src/modules/documents/services/documentImageCaptureQueue.js";
import { InMemoryDocumentProcessingJobRepository, InMemoryDocumentRepository } from "../../support/fakes.js";
import { InMemoryDocumentImageRows } from "../../support/inMemoryDocumentImageRows.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const DOCUMENT_ID = "22222222-2222-4222-8222-222222222222";

const placed = (sourceUrl: string, position: number, role: "primary" | "inline" = "primary", textOffset: number | null = null) =>
  ({ sourceUrl, role, alt: "", caption: null, position, textOffset });

const setup = () => {
  const rows = new InMemoryDocumentImageRows();
  const jobs = new InMemoryDocumentProcessingJobRepository(new InMemoryDocumentRepository());
  const dispatcher = { dispatch: vi.fn().mockResolvedValue(undefined), dispatchMany: vi.fn().mockResolvedValue(undefined) };
  const logger = { warn: vi.fn() };
  const queue = new DocumentImageCaptureQueue({ images: rows, jobs, dispatcher, logger });
  const captureJobs = () => [...jobs.items.values()].filter((job) => job.kind === "images");
  return { queue, rows, jobs, dispatcher, logger, captureJobs };
};

describe("DocumentImageCaptureQueue", () => {
  it("records a new revision's images and leaves capture to the vectorize job that publishes it", async () => {
    const { queue, rows, captureJobs } = setup();

    await queue.recordCandidates({
      workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID, revision: 2, published: false,
      images: [placed("https://cdn.shop.example/cover.jpg", 0), placed("https://cdn.shop.example/ridge.jpg", 1, "inline", 40)],
    });

    expect(rows.forDocument(DOCUMENT_ID).map((row) => [row.sourceUrl, row.status])).toEqual([
      ["https://cdn.shop.example/cover.jpg", "pending"],
      ["https://cdn.shop.example/ridge.jpg", "pending"],
    ]);
    expect(captureJobs()).toEqual([]);
  });

  it("queues capture at once when an unchanged page names a new image, and not when nothing changed", async () => {
    const { queue, dispatcher, captureJobs } = setup();
    const images = [placed("https://cdn.shop.example/cover.jpg", 0)];

    await queue.recordCandidates({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID, revision: 2, published: true, images });
    const [first] = captureJobs();
    first.status = "completed";
    await queue.recordCandidates({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID, revision: 2, published: true, images });

    expect(captureJobs()).toHaveLength(1);
    expect(captureJobs()[0]).toMatchObject({ documentRevision: 2, status: "completed" });
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
  });

  it("releases an image the content no longer names", async () => {
    const { queue, rows } = setup();
    await queue.recordCandidates({
      workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID, revision: 1, published: false,
      images: [placed("https://cdn.shop.example/cover.jpg", 0), placed("https://cdn.shop.example/old.jpg", 1, "inline", 10)],
    });

    await queue.recordCandidates({
      workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID, revision: 2, published: false,
      images: [placed("https://cdn.shop.example/cover.jpg", 0)],
    });

    expect(rows.forDocument(DOCUMENT_ID).map((row) => row.sourceUrl)).toEqual(["https://cdn.shop.example/cover.jpg"]);
    expect(rows.byUrl("https://cdn.shop.example/old.jpg")?.documentId).toBeNull();
  });

  it("queues capture after a revision is published when the document names any image, and queues a finished one again", async () => {
    const { queue, rows, jobs, dispatcher, captureJobs } = setup();
    rows.seed({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID, sourceUrl: "https://cdn.shop.example/cover.jpg", role: "primary" });
    // The vectorize job that published the revision, as the worker hands it over.
    const revision = await jobs.enqueue({ documentId: DOCUMENT_ID, workspaceId: WORKSPACE_ID, documentRevision: 4 });
    revision.status = "completed";

    await queue.afterRevisionPublished(revision);
    captureJobs()[0].status = "completed";
    await queue.afterRevisionPublished(revision);
    await queue.afterRevisionPublished({ ...revision, documentId: "33333333-3333-4333-8333-333333333333" });

    expect(captureJobs()).toHaveLength(1);
    expect(captureJobs()[0]).toMatchObject({ kind: "images", documentRevision: 4, status: "queued" });
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(2);
  });

  it("never fails the caller when recording or queueing does", async () => {
    const { queue, rows, dispatcher, logger } = setup();
    rows.recordCandidates = () => Promise.reject(new Error("database unavailable"));
    dispatcher.dispatch.mockRejectedValue(new Error("queue unavailable"));
    rows.seed({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID, sourceUrl: "https://cdn.shop.example/cover.jpg", role: "primary" });

    await expect(queue.recordCandidates({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID, revision: 1, published: true, images: [] })).resolves.toBeUndefined();
    await expect(queue.afterRevisionPublished({ documentId: DOCUMENT_ID, workspaceId: WORKSPACE_ID, documentRevision: 1 })).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });
});
