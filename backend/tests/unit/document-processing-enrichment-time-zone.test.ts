import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DocumentProcessingService } from "../../src/modules/documents/services/documentProcessingService.js";
import type {
  DocumentEnrichmentStageInput,
  DocumentEnrichmentStagePort,
} from "../../src/modules/documents/services/documentEnrichmentService.js";
import type { ChunkingStrategy } from "../../src/modules/retrieval/domain/chunking/chunkingStrategy.js";
import { ChunkingStrategyRegistry } from "../../src/modules/retrieval/domain/chunking/chunkingStrategyRegistry.js";
import { defaultIngestionSettings } from "../../src/modules/settings/domain/ingestionSettings.js";
import type { DocumentProcessingJobRecord } from "../../src/db/repositories/documentProcessingJobRepository.js";
import {
  createAuditService,
  InMemoryChunkRepository,
  InMemoryDocumentProcessingJobRepository,
  InMemoryDocumentRepository,
} from "../support/fakes.js";
import { createDocumentEmbeddingPort } from "../support/embeddingPorts.js";

// 18:00 on 11 November in Los Angeles is already 12 November in UTC.
const CREATED_AT = new Date("2026-11-12T02:00:00.000Z");

const singleChunk: ChunkingStrategy = {
  id: "structured_semantic",
  async chunk() {
    return [{ chunkIndex: 0, content: "Open day tomorrow.", startOffset: 0, endOffset: 18 }];
  },
};

const job = (documentId: string, revision: number, kind: "vectorize" | "enrich"): DocumentProcessingJobRecord => ({
  id: `job-${kind}`,
  documentId,
  workspaceId: "workspace-1",
  documentRevision: revision,
  kind,
  status: "processing",
  attemptCount: 1,
  lastError: null,
  availableAt: new Date(),
  claimedAt: new Date(),
  completedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  options: null,
});

/** `undefined` leaves the workspace-zone reader unwired. */
const enrichmentAnchor = async (workspaceTimeZone: string | null | undefined) => {
  const documentRepository = new InMemoryDocumentRepository();
  const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
  documentRepository.setJobRepository(jobRepository);
  const chunkRepository = new InMemoryChunkRepository(documentRepository);
  const inputs: DocumentEnrichmentStageInput[] = [];
  const stage: DocumentEnrichmentStagePort = {
    async enrich(input) {
      inputs.push(input);
      return {
        status: "applied",
        outcome: "applied",
        documentMetadata: {},
        provenance: { status: "applied", shape: "generic", anchorDate: input.anchor.date, anchorSource: input.anchor.source },
        chunks: input.chunks,
        factCount: 0,
        droppedFactCount: 0,
        appliedChunkCount: 0,
        modelAttemptCount: 1,
        firstAttemptFailureReason: null,
      };
    },
  };
  const readWorkspaceTimeZone = vi.fn(async () => workspaceTimeZone ?? null);
  const document = await documentRepository.create({
    workspaceId: "workspace-1",
    title: "Open day",
    sourceContent: "Open day tomorrow.",
    markdownContent: "Open day tomorrow.",
    status: "queued",
  });
  const service = new DocumentProcessingService(
    documentRepository,
    chunkRepository,
    createDocumentEmbeddingPort({ async embedTexts(texts: string[]) { return texts.map(() => [1, 2, 3]); } }),
    createAuditService(),
    { async getForWorkspace(workspaceId: string) { return { ...defaultIngestionSettings(workspaceId), chunkingStrategy: "structured_semantic" as const, documentEnrichmentEnabled: true }; } },
    new ChunkingStrategyRegistry([singleChunk]),
    undefined,
    undefined,
    stage,
    undefined,
    jobRepository,
    undefined,
    undefined,
    undefined,
    undefined,
    workspaceTimeZone === undefined ? undefined : { readWorkspaceTimeZone },
  );

  await service.process(job(document.id, document.revision, "vectorize"));
  await service.processEnrichment(job(document.id, document.revision, "enrich"));

  return { anchor: inputs[0]?.anchor, provenance: documentRepository.items.get(document.id)?.enrichment, readWorkspaceTimeZone };
};

describe("document enrichment anchor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(CREATED_AT);
  });
  afterEach(() => vi.useRealTimers());

  it("is the creation date in the workspace's zone, the local day rather than the UTC one", async () => {
    const { anchor, provenance, readWorkspaceTimeZone } = await enrichmentAnchor("America/Los_Angeles");

    expect(anchor).toEqual({ source: "document_created_at", date: "2026-11-11", timeZone: "America/Los_Angeles" });
    expect(provenance).toMatchObject({ anchorDate: "2026-11-11" });
    expect(readWorkspaceTimeZone).toHaveBeenCalledWith("workspace-1");
  });

  it("is the UTC date only when the workspace sets no zone", async () => {
    expect((await enrichmentAnchor(null)).anchor).toEqual({ source: "document_created_at", date: "2026-11-12", timeZone: "UTC" });
    expect((await enrichmentAnchor(undefined)).anchor).toEqual({ source: "document_created_at", date: "2026-11-12", timeZone: "UTC" });
  });

  it("ignores a stored zone the runtime does not know, and reads UTC", async () => {
    expect((await enrichmentAnchor("Not/AZone")).anchor).toEqual({ source: "document_created_at", date: "2026-11-12", timeZone: "UTC" });
  });
});
