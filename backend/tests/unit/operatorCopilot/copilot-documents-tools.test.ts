import { describe, expect, it, vi } from "vitest";

import type { ChunkRepositoryPort } from "../../../src/modules/documents/contracts/index.js";
import {
  createDocumentKnowledgeCopilotTools,
  type CopilotDocumentMaintenancePort,
} from "../../../src/modules/operatorCopilot/tools/documents.js";
import { buildDescriptors, documentSkillsContext as context, documentStatusPorts } from "./copilot-tools-test-helpers.js";

const documentId = "11111111-1111-4111-8111-111111111111";
const sourceId = "22222222-2222-4222-8222-222222222222";
const chunkIds = Array.from({ length: 12 }, (_, index) => `chunk-${index}`);

const knowledgePorts = () => {
  const fullChunkText = `Complete middle chunk: ${"evidence ".repeat(120)}`;
  const chunks = chunkIds.map((id, chunkIndex) => ({
    id,
    documentId,
    workspaceId: "workspace-1",
    chunkIndex,
    content: chunkIndex === 8 ? fullChunkText : `complete-${chunkIndex}`,
    searchText: chunkIndex === 8 ? "indexed middle evidence" : null,
    startOffset: chunkIndex * 100,
    endOffset: (chunkIndex + 1) * 100,
    metadata: { heading: `Section ${chunkIndex}` },
    dateFrom: null,
    dateTo: null,
    createdAt: new Date("2026-08-30T10:00:00.000Z"),
    embeddingDimensions: chunkIndex === 8 ? 1536 : null,
  }));
  const listPageForDocument = vi.fn(async (input: {
    documentId: string;
    workspaceId: string;
    startChunkIndex: number;
    limit: number;
  }): Promise<Awaited<ReturnType<ChunkRepositoryPort["listPageForDocument"]>>> => {
    const page = chunks
      .filter((chunk) => chunk.chunkIndex >= input.startChunkIndex)
      .slice(0, input.limit);
    const lastChunkIndex = page.at(-1)?.chunkIndex;
    return {
      chunks: page,
      totalChunks: chunks.length,
      nextChunkIndex: lastChunkIndex === undefined
        ? null
        : chunks.find((chunk) => chunk.chunkIndex > lastChunkIndex)?.chunkIndex ?? null,
    };
  });
  const reprocessDocument = vi.fn(async (): Promise<Awaited<ReturnType<CopilotDocumentMaintenancePort["reprocessDocument"]>>> => ({
    documentId,
    status: "queued" as const,
    queuedDocumentCount: 1,
    skippedDocumentCount: 0,
  }));
  const reprocessSource = vi.fn(async () => ({
    workspaceId: "workspace-1",
    sourceId,
    queuedDocumentCount: 4,
    skippedDocumentCount: 1,
    status: "queued" as const,
  }));
  const recrawlSource = vi.fn(async () => ({
    jobId: "44444444-4444-4444-8444-444444444444",
    sourceId,
    requestedUrl: "https://help.example.com",
    status: "queued" as const,
  }));
  return {
    fullChunkText,
    listPageForDocument,
    reprocessDocument,
    reprocessSource,
    recrawlSource,
  };
};

describe("copilot document readers", () => {
  it("reports a missing document instead of an empty chunk page", async () => {
    const ports = knowledgePorts();
    ports.listPageForDocument.mockResolvedValueOnce(null);
    const descriptor = createDocumentKnowledgeCopilotTools({ documentChunks: ports, documentMaintenance: ports })
      .find((candidate) => candidate.name === "document_chunks")!;

    await expect(descriptor.createTool(context).invoke({ documentId, startChunkIndex: 0, limit: 1 }, {} as never))
      .rejects.toThrow("Document not found");
  });

  it("reports workspace ingestion counts, the attention list, and source sync state", async () => {
    const documents = documentStatusPorts();
    const descriptors = buildDescriptors(documents);

    const result = await descriptors[0].createTool(context).invoke({}, {} as never) as {
      counts: Record<string, number>;
      attention: Array<Record<string, unknown>>;
      sources: Array<Record<string, unknown>>;
    };

    expect(documents.summarizeWorkspace).toHaveBeenCalledWith("workspace-1");
    expect(documents.listByStatuses).toHaveBeenCalledWith("workspace-1", ["failed", "queued", "processing"], { limit: 25 });
    expect(documents.listByWorkspaceIdWithDocumentCounts).toHaveBeenCalledTimes(1);
    expect(result.counts).toEqual({ total: 12, ready: 9, pending: 2, failed: 1 });
    expect(result.attention).toEqual([
      {
        id: "document-1",
        title: "Refund policy",
        status: "failed",
        failureReason: "Parser timed out",
        updatedAt: "2026-08-02T10:00:00.000Z",
        sourceId: "source-1",
      },
    ]);
    expect(result.sources).toEqual([
      {
        id: "source-1",
        kind: "website",
        label: "Help center",
        lastSyncStatus: "failed",
        lastSyncedAt: "2026-08-02T09:00:00.000Z",
        documentCount: 4,
      },
    ]);
  });

  it("never emits document content, metadata values, or source credentials", async () => {
    const descriptors = buildDescriptors();
    const serialized = JSON.stringify(await descriptors[0].createTool(context).invoke({}, {} as never));

    expect(serialized).not.toContain("person@example.com");
    expect(serialized).not.toContain("sk-secret-value");
    expect(serialized).not.toContain("metadata");
    expect(serialized).not.toContain("config");
  });

  it("is workspace scoped, so it links no single entity", () => {
    expect(buildDescriptors()[0].describeEntity).toBeUndefined();
  });

  it("returns a full-text chunk-index range without generic payload truncation", async () => {
    const ports = knowledgePorts();
    const descriptor = createDocumentKnowledgeCopilotTools({
      documentChunks: ports,
      documentMaintenance: ports,
    }).find((candidate) => candidate.name === "document_chunks")!;

    const result = await descriptor.createTool(context).invoke({
      documentId,
      startChunkIndex: 8,
      limit: 1,
    }, {} as never) as {
      chunks: Array<Record<string, unknown>>;
      totalChunks: number;
      nextChunkIndex: number | null;
      unavailableChunkIds: string[];
    };

    expect(ports.listPageForDocument).toHaveBeenCalledWith({
      documentId,
      workspaceId: "workspace-1",
      startChunkIndex: 8,
      limit: 1,
    });
    expect(result).toMatchObject({ totalChunks: 12, nextChunkIndex: 9, unavailableChunkIds: [] });
    expect(result.chunks).toEqual([{
      id: chunkIds[8],
      chunkIndex: 8,
      content: ports.fullChunkText,
      searchText: "indexed middle evidence",
      startOffset: 800,
      endOffset: 900,
      metadata: { heading: "Section 8" },
      dateFrom: null,
      dateTo: null,
      createdAt: "2026-08-30T10:00:00.000Z",
      embedding: { present: true, dimensions: 1536 },
    }]);
    expect(result.chunks[0]?.content).toBe(ports.fullChunkText);
  });

  it("never returns more than the structural page cap", async () => {
    const ports = knowledgePorts();
    const descriptor = createDocumentKnowledgeCopilotTools({ documentChunks: ports, documentMaintenance: ports })[0];

    const result = await descriptor.createTool(context).invoke({
      documentId,
      startChunkIndex: 0,
      limit: 10,
    }, {} as never) as { chunks: unknown[]; totalChunks: number; nextChunkIndex: number | null };

    expect(result.chunks).toHaveLength(10);
    expect(result.totalChunks).toBe(12);
    expect(result.nextChunkIndex).toBe(10);
  });

  it("bounds chunk pages structurally and links the inspected document", () => {
    const descriptor = createDocumentKnowledgeCopilotTools({
      documentChunks: knowledgePorts(),
      documentMaintenance: knowledgePorts(),
    })[0];

    expect(descriptor.inputSchema.safeParse({ documentId, startChunkIndex: 0, limit: 11 }).success).toBe(false);
    expect(descriptor.describeEntity?.({ documentId, startChunkIndex: 0, limit: 1 }, context)).toEqual({
      type: "document",
      id: documentId,
    });
  });

  it("classifies document and source maintenance as manage-permission acts", () => {
    const descriptors = createDocumentKnowledgeCopilotTools({
      documentChunks: knowledgePorts(),
      documentMaintenance: knowledgePorts(),
    });

    expect(descriptors.map(({ name, shape, requiredPermissions }) => ({ name, shape, requiredPermissions }))).toEqual([
      { name: "document_chunks", shape: "read", requiredPermissions: ["workspace.documents.read"] },
      { name: "reprocess_document", shape: "act", requiredPermissions: ["workspace.documents.manage"] },
      { name: "recrawl_source", shape: "act", requiredPermissions: ["workspace.documents.manage"] },
    ]);
  });

  it("reprocesses exactly one workspace-scoped document or source target", async () => {
    const ports = knowledgePorts();
    const descriptor = createDocumentKnowledgeCopilotTools({ documentChunks: ports, documentMaintenance: ports })[1];

    await expect(descriptor.createTool(context).invoke({ documentId }, {} as never)).resolves.toEqual({
      target: { type: "document", id: documentId },
      status: "queued",
      queuedDocumentCount: 1,
      skippedDocumentCount: 0,
    });
    await expect(descriptor.createTool(context).invoke({ sourceId }, {} as never)).resolves.toEqual({
      target: { type: "source", id: sourceId },
      status: "queued",
      queuedDocumentCount: 4,
      skippedDocumentCount: 1,
    });

    expect(ports.reprocessDocument).toHaveBeenCalledWith({
      documentId,
      workspaceId: "workspace-1",
      documentEnrichmentOverride: undefined,
    });
    expect(ports.reprocessSource).toHaveBeenCalledWith({
      sourceId,
      workspaceId: "workspace-1",
      documentEnrichmentOverride: undefined,
    });
    expect(descriptor.inputSchema.safeParse({ documentId, sourceId }).success).toBe(false);
    expect(descriptor.inputSchema.safeParse({}).success).toBe(false);
  });

  it("reports a no-op when the target document is already queued or processing", async () => {
    const ports = knowledgePorts();
    ports.reprocessDocument.mockResolvedValueOnce({
      documentId,
      status: "noop",
      queuedDocumentCount: 0,
      skippedDocumentCount: 1,
    });
    const descriptor = createDocumentKnowledgeCopilotTools({ documentChunks: ports, documentMaintenance: ports })[1];

    await expect(descriptor.createTool(context).invoke({ documentId }, {} as never)).resolves.toEqual({
      target: { type: "document", id: documentId },
      status: "noop",
      queuedDocumentCount: 0,
      skippedDocumentCount: 1,
    });
  });

  it("recrawls only a stored source id and never accepts caller-supplied crawl configuration", async () => {
    const ports = knowledgePorts();
    const descriptor = createDocumentKnowledgeCopilotTools({ documentChunks: ports, documentMaintenance: ports })[2];

    await expect(descriptor.createTool(context).invoke({ sourceId }, {} as never)).resolves.toEqual({
      jobId: "44444444-4444-4444-8444-444444444444",
      sourceId,
      requestedUrl: "https://help.example.com",
      status: "queued",
    });
    expect(ports.recrawlSource).toHaveBeenCalledWith({
      accountId: "account-1",
      sourceId,
      workspaceId: "workspace-1",
    });
    expect(descriptor.inputSchema.safeParse({ sourceId, url: "https://different.example.com" }).success).toBe(false);
  });
});
