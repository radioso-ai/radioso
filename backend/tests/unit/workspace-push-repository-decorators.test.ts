import { describe, expect, it, vi } from "vitest";

import {
  withChunkPushEvents,
  withDocumentPushEvents,
  withWebsiteCrawlPushEvents,
} from "../../src/app/composition/workspacePushRepositoryDecorators.js";
import type { WebsiteCrawlJobRepositoryPort } from "../../src/db/repositories/websiteCrawlJobRepository.js";
import type { ChunkRepositoryPort, DocumentRepositoryPort } from "../../src/modules/documents/contracts/index.js";
import { InMemoryWorkspaceEventBus } from "../../src/shared/events/workspaceEventBus.js";

describe("workspace push repository decorators", () => {
  it("publishes document status changes only after successful writes", async () => {
    const bus = new InMemoryWorkspaceEventBus();
    const events = bus.subscribe("workspace-1")[Symbol.asyncIterator]();
    const repository = withDocumentPushEvents({
      setStatus: vi.fn().mockResolvedValue({ id: "document-1" }),
      setStatusIfRevisionMatches: vi.fn().mockResolvedValue(null),
    } as unknown as DocumentRepositoryPort, bus);

    await repository.setStatus({ documentId: "document-1", workspaceId: "workspace-1", status: "processing" });
    await repository.setStatusIfRevisionMatches({
      documentId: "document-1",
      workspaceId: "workspace-1",
      revision: 1,
      status: "ready",
    });

    await expect(events.next()).resolves.toMatchObject({
      value: {
        resourceType: "document",
        resourceId: "document-1",
        workspaceId: "workspace-1",
        changeKind: "document.status_changed",
      },
    });
    await events.return?.();
  });

  it("publishes document readiness after chunk publication and crawl checkpoints", async () => {
    const bus = new InMemoryWorkspaceEventBus();
    const events = bus.subscribe("workspace-1")[Symbol.asyncIterator]();
    const chunks = withChunkPushEvents(
      { publishForDocumentRevision: vi.fn().mockResolvedValue(true) } as unknown as ChunkRepositoryPort,
      bus,
    );
    const crawl = withWebsiteCrawlPushEvents(
      {
        updateCheckpoint: vi.fn().mockResolvedValue(undefined),
        markCompleted: vi.fn().mockResolvedValue({ id: "crawl-1", workspaceId: "workspace-1" }),
      } as unknown as WebsiteCrawlJobRepositoryPort,
      bus,
    );

    await chunks.publishForDocumentRevision({
      documentId: "document-1",
      workspaceId: "workspace-1",
      revision: 1,
      chunks: [],
      embeddingSpace: { id: "space-1", dimensions: 1536, distanceMetric: "cosine" },
      canonicalVersion: "1",
    });
    await crawl.updateCheckpoint("crawl-1", "workspace-1", {
      discoveredUrls: [], queuedUrls: [], processingUrls: [], processedCanonicalUrls: [],
      accepted: 0, skipped: 0, failed: 0, lastProcessedAt: null,
    });

    const completed = await crawl.markCompleted("crawl-1", {});

    expect(completed).toMatchObject({ id: "crawl-1", workspaceId: "workspace-1" });
    await expect(events.next()).resolves.toMatchObject({ value: { changeKind: "document.status_changed" } });
    await expect(events.next()).resolves.toMatchObject({
      value: { resourceId: "crawl-1", changeKind: "crawl.progress" },
    });
    await expect(events.next()).resolves.toMatchObject({
      value: { resourceId: "crawl-1", changeKind: "crawl.status_changed" },
    });
    await events.return?.();
  });
});
