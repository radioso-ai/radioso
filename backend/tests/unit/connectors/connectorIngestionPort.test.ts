import { describe, expect, it, vi } from "vitest";

import { createConnectorIngestionPort } from "../../../src/modules/connectors/services/connectorIngestionPort.js";

describe("createConnectorIngestionPort", () => {
  it("forwards ingest() to DocumentIngestionService verbatim", async () => {
    const ingest = vi.fn(async () => ({ documentId: "doc-1", status: "queued" }));
    const port = createConnectorIngestionPort({
      documentIngestionService: { ingest } as any,
      documentDeletionService: { delete: vi.fn() } as any,
      documentRepository: { findByExternalDocumentId: vi.fn() } as any,
    });

    const result = await port.ingest({
      workspaceId: "ws-1",
      title: "T",
      content: "C",
      externalDocumentId: "wp_post_1",
      metadata: { source: "wordpress" },
    });

    expect(result).toEqual({ documentId: "doc-1", status: "queued" });
    expect(ingest).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      title: "T",
      content: "C",
      externalDocumentId: "wp_post_1",
      metadata: { source: "wordpress" },
    });
  });

  it("returns false from deleteByExternalId when no matching document exists", async () => {
    const findByExternalDocumentId = vi.fn(async () => null);
    const deleteFn = vi.fn();
    const port = createConnectorIngestionPort({
      documentIngestionService: { ingest: vi.fn() } as any,
      documentDeletionService: { delete: deleteFn } as any,
      documentRepository: { findByExternalDocumentId } as any,
    });

    const deleted = await port.deleteByExternalId({
      workspaceId: "ws-1",
      externalDocumentId: "wp_post_999",
    });

    expect(deleted).toBe(false);
    expect(deleteFn).not.toHaveBeenCalled();
  });

  it("resolves external id then delegates to DocumentDeletionService", async () => {
    const findByExternalDocumentId = vi.fn(async () => ({ id: "doc-xyz" }));
    const deleteFn = vi.fn(async () => {});
    const port = createConnectorIngestionPort({
      documentIngestionService: { ingest: vi.fn() } as any,
      documentDeletionService: { delete: deleteFn } as any,
      documentRepository: { findByExternalDocumentId } as any,
    });

    const deleted = await port.deleteByExternalId({
      workspaceId: "ws-1",
      externalDocumentId: "wp_post_42",
    });

    expect(deleted).toBe(true);
    expect(findByExternalDocumentId).toHaveBeenCalledWith("ws-1", "wp_post_42");
    expect(deleteFn).toHaveBeenCalledWith({ workspaceId: "ws-1", documentId: "doc-xyz" });
  });
});
