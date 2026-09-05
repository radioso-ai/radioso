import { describe, expect, it } from "vitest";

import { createWebsiteCrawlerIngestionPort } from "../../src/app/composition/websiteCrawlerIngestionPort.js";

/**
 * Stands in for DocumentIngestionService: a class whose public methods reach private state
 * through `this`, so any member that loses its receiver throws instead of answering.
 */
class IngestionServiceStub {
  private readonly resolvedSources: string[] = [];

  async ingest(input: { workspaceId: string; title: string; content: string }) {
    return { documentId: this.tag(input.title), status: "queued" };
  }

  async resolveSource(input: { workspaceId: string; source: { id: string } | { kind: "website"; url: string } }) {
    const id = "id" in input.source ? input.source.id : input.source.url;
    this.resolvedSources.push(id);
    return { id };
  }

  async updateSourceSyncState(input: { workspaceId: string; sourceId: string; status: string }) {
    this.tag(input.sourceId);
  }

  async reapMissingPages(_input: { workspaceId: string; sourceId: string; keepExternalDocumentIds: string[] }) {
    return { deletedCount: this.resolvedSources.length, deletedContentBytes: 0 };
  }

  private tag(value: string): string {
    return `stub-${value}`;
  }
}

describe("website crawler ingestion port", () => {
  it("keeps every member callable after a consumer detaches it from the port", async () => {
    const port = createWebsiteCrawlerIngestionPort(new IngestionServiceStub());
    const { ingest, resolveSource, updateSourceSyncState, reapMissingPages } = port;

    await expect(resolveSource!({ workspaceId: "workspace-1", source: { id: "source-1" } }))
      .resolves.toEqual({ id: "source-1" });
    await expect(ingest({ workspaceId: "workspace-1", title: "About", content: "alpha" }))
      .resolves.toEqual({ documentId: "stub-About", status: "queued" });
    await expect(updateSourceSyncState!({ workspaceId: "workspace-1", sourceId: "source-1", status: "success" }))
      .resolves.toBeUndefined();
    await expect(reapMissingPages!({ workspaceId: "workspace-1", sourceId: "source-1", keepExternalDocumentIds: [] }))
      .resolves.toEqual({ deletedCount: 1, deletedContentBytes: 0 });
  });

  it("forwards arguments unchanged to the underlying service", async () => {
    const service = new IngestionServiceStub();
    const port = createWebsiteCrawlerIngestionPort(service);

    await port.resolveSource!({ workspaceId: "workspace-1", source: { kind: "website", url: "https://example.com" } });

    await expect(port.reapMissingPages!({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      keepExternalDocumentIds: [],
    })).resolves.toEqual({ deletedCount: 1, deletedContentBytes: 0 });
  });
});
