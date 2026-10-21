import { describe, expect, it } from "vitest";

import { createDefaultDocumentEnrichmentStrategyRegistry } from "../../src/modules/documents/domain/enrichment/enrichmentStrategies.js";
import {
  DocumentEnrichmentService,
  type DocumentEnrichmentGateway,
} from "../../src/modules/documents/services/documentEnrichmentService.js";
import { DocumentIngestionService } from "../../src/modules/documents/services/documentIngestionService.js";
import { DocumentProcessingService } from "../../src/modules/documents/services/documentProcessingService.js";
import type { ChunkingStrategy } from "../../src/modules/retrieval/domain/chunking/chunkingStrategy.js";
import { ChunkingStrategyRegistry } from "../../src/modules/retrieval/domain/chunking/chunkingStrategyRegistry.js";
import { defaultIngestionSettings } from "../../src/modules/settings/domain/ingestionSettings.js";
import {
  createAuditService,
  InMemoryChunkRepository,
  InMemoryDocumentProcessingJobRepository,
  InMemoryDocumentRepository,
} from "../support/fakes.js";
import { createDocumentEmbeddingPort } from "../support/embeddingPorts.js";

const WORKSPACE_ID = "workspace-calendar";
const OPERATOR_DATES = { dateFrom: "2026-03-02", dateTo: "2026-03-06" };
const MODEL_DATES = { dateFrom: "2026-05-10", dateTo: "2026-05-12" };

const COURSE = "Meditation course for returning students.\n\nThe course runs from 2 to 6 March 2026.";
const RESCHEDULED_COURSE = "Meditation course for returning students.\n\nThe course now runs from 10 to 12 May 2026.";

// One chunk per paragraph, with offsets into the markdown the enrichment run reads.
const paragraphChunking: ChunkingStrategy = {
  id: "structured_semantic",
  async chunk({ content }) {
    const chunks: Array<{ chunkIndex: number; content: string; startOffset: number; endOffset: number }> = [];
    let offset = 0;
    for (const paragraph of content.split("\n\n")) {
      chunks.push({ chunkIndex: chunks.length, content: paragraph, startOffset: offset, endOffset: offset + paragraph.length });
      offset += paragraph.length + 2;
    }
    return chunks;
  },
};

type ModelReply = { kind: "dates"; dateFrom: string; dateTo: string } | { kind: "failure" };

// The model reads one event spanning the whole body. The representation is
// "Title: …\nCreated at: …\n\n" + body, so the body starts after the first blank line.
const scriptedGateway = (script: { next: ModelReply }): DocumentEnrichmentGateway => ({
  async generate({ documentRepresentation }) {
    const reply = script.next;
    if (reply.kind === "failure") {
      throw new Error("provider unavailable");
    }
    const bodyStart = documentRepresentation.indexOf("\n\n") + 2;
    return {
      model: "gpt-5-mini",
      output: {
        type: "event",
        confidence: 0.92,
        facts: [
          {
            id: "course",
            kind: "event_date",
            label: "course",
            dateFrom: reply.dateFrom,
            dateTo: reply.dateTo,
            sourceRange: { start: bodyStart, end: documentRepresentation.length },
          },
        ],
      },
    };
  },
});

const buildCalendarWorkspace = (options: { workspaceExtractionEnabled?: boolean } = {}) => {
  const documentRepository = new InMemoryDocumentRepository();
  const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
  documentRepository.setJobRepository(jobRepository);
  const chunkRepository = new InMemoryChunkRepository(documentRepository);
  const auditService = createAuditService();
  const model = { next: { kind: "failure" } as ModelReply };

  const ingestion = new DocumentIngestionService(documentRepository, auditService);
  const processing = new DocumentProcessingService(
    documentRepository,
    chunkRepository,
    createDocumentEmbeddingPort({
      async embedTexts(texts: string[]): Promise<number[][]> {
        return texts.map(() => [1, 2, 3]);
      },
    }),
    auditService,
    {
      // Extraction is off by default, as in the workspace that loads its
      // calendar through the API; every run that extracts asks for it.
      async getForWorkspace(workspaceId: string) {
        return {
          ...defaultIngestionSettings(workspaceId),
          chunkingStrategy: "structured_semantic" as const,
          documentEnrichmentEnabled: options.workspaceExtractionEnabled ?? false,
        };
      },
    },
    new ChunkingStrategyRegistry([paragraphChunking]),
    undefined,
    undefined,
    new DocumentEnrichmentService({
      gateway: scriptedGateway(model),
      strategyRegistry: createDefaultDocumentEnrichmentStrategyRegistry(),
      now: () => new Date("2026-02-01T09:00:00.000Z"),
    }),
    undefined,
    jobRepository,
  );

  const finished = new Set<string>();
  // Runs every queued job the way the worker does: indexing first, extraction behind it.
  const drain = async (): Promise<void> => {
    for (const kind of ["vectorize", "enrich"] as const) {
      for (const job of [...jobRepository.items.values()]) {
        if (job.kind !== kind || finished.has(job.id)) {
          continue;
        }
        finished.add(job.id);
        await (kind === "vectorize" ? processing.process(job) : processing.processEnrichment(job));
      }
    }
  };

  const createDocument = async (input: {
    metadata?: Record<string, unknown>;
    override?: "on" | "off";
    reply?: ModelReply;
  }): Promise<string> => {
    model.next = input.reply ?? { kind: "failure" };
    const created = await ingestion.ingest({
      workspaceId: WORKSPACE_ID,
      title: "Meditation course",
      content: COURSE,
      metadata: input.metadata,
      documentEnrichmentOverride: input.override,
    });
    await drain();
    return created.documentId;
  };

  const put = async (documentId: string, input: {
    content?: string;
    metadata?: Record<string, unknown>;
    override?: "on" | "off";
    reply?: ModelReply;
  }): Promise<void> => {
    model.next = input.reply ?? { kind: "failure" };
    await ingestion.update({
      workspaceId: WORKSPACE_ID,
      documentId,
      title: "Meditation course",
      content: input.content ?? COURSE,
      metadata: input.metadata,
      documentEnrichmentOverride: input.override,
    });
    await drain();
  };

  const reprocess = async (documentId: string, input: { override?: "on" | "off"; reply?: ModelReply }): Promise<void> => {
    model.next = input.reply ?? { kind: "failure" };
    await ingestion.reprocess({ workspaceId: WORKSPACE_ID, documentId, documentEnrichmentOverride: input.override });
    await drain();
  };

  const editMetadata = async (documentId: string, metadata: Record<string, unknown>, reply?: ModelReply): Promise<void> => {
    model.next = reply ?? { kind: "failure" };
    await ingestion.updateRetrievalSettings({ workspaceId: WORKSPACE_ID, documentId, metadata });
    await drain();
  };

  const documentOf = (documentId: string) => documentRepository.items.get(documentId);
  const chunkMetadataOf = (documentId: string) =>
    (chunkRepository.items.get(documentId) ?? []).map((chunk) => chunk.metadata ?? {});

  const enrichmentAudits = () => auditService.events.filter((event) => event.eventType === "document.enrichment");

  return { createDocument, put, reprocess, editMetadata, documentOf, chunkMetadataOf, enrichmentAudits, documentRepository };
};

const expectDatedEverywhere = (
  workspace: ReturnType<typeof buildCalendarWorkspace>,
  documentId: string,
  dates: { dateFrom: string; dateTo: string },
): void => {
  expect(workspace.documentOf(documentId)?.metadata).toMatchObject(dates);
  const chunks = workspace.chunkMetadataOf(documentId);
  expect(chunks).toHaveLength(2);
  for (const metadata of chunks) {
    expect(metadata).toMatchObject(dates);
  }
};

describe("operator-written event dates", () => {
  it("survive a PUT and a reprocess without an override after a failed extraction run", async () => {
    const workspace = buildCalendarWorkspace();
    const documentId = await workspace.createDocument({ metadata: OPERATOR_DATES, override: "on", reply: { kind: "failure" } });
    expect(workspace.documentOf(documentId)?.enrichment).toMatchObject({ status: "failed" });

    await workspace.put(documentId, { metadata: OPERATOR_DATES });
    expectDatedEverywhere(workspace, documentId, OPERATOR_DATES);

    await workspace.reprocess(documentId, { override: "off" });
    expectDatedEverywhere(workspace, documentId, OPERATOR_DATES);
  });

  it("survive a PUT with extraction forced on whose run fails", async () => {
    const workspace = buildCalendarWorkspace();
    const documentId = await workspace.createDocument({ metadata: OPERATOR_DATES, override: "on", reply: { kind: "failure" } });

    await workspace.put(documentId, { metadata: OPERATOR_DATES, override: "on", reply: { kind: "failure" } });

    expectDatedEverywhere(workspace, documentId, OPERATOR_DATES);
    expect(workspace.documentOf(documentId)?.enrichment).toMatchObject({ status: "failed" });
  });

  it("win over the dates a successful run reads, on the document and on every chunk", async () => {
    const workspace = buildCalendarWorkspace();
    const documentId = await workspace.createDocument({
      metadata: OPERATOR_DATES,
      override: "on",
      reply: { kind: "dates", ...MODEL_DATES },
    });

    expectDatedEverywhere(workspace, documentId, OPERATOR_DATES);
    const enrichment = workspace.documentOf(documentId)?.enrichment;
    expect(enrichment).toMatchObject({ status: "applied", generatedKeys: [], dateOwnershipRecorded: true });
    expect(enrichment?.fieldCounts?.skippedCollision).toBe(2);
    expect(workspace.enrichmentAudits().at(-1)?.metadata).toMatchObject({ status: "applied", skippedCollisionCount: 2 });

    await workspace.reprocess(documentId, { override: "on", reply: { kind: "dates", ...MODEL_DATES } });
    expectDatedEverywhere(workspace, documentId, OPERATOR_DATES);

    await workspace.reprocess(documentId, { override: "off" });
    expectDatedEverywhere(workspace, documentId, OPERATOR_DATES);
  });

  it("survive under provenance recorded before extraction tracked date ownership", async () => {
    const workspace = buildCalendarWorkspace();
    const documentId = await workspace.createDocument({ metadata: OPERATOR_DATES });
    const current = workspace.documentOf(documentId)!;
    workspace.documentRepository.items.set(documentId, {
      ...current,
      enrichment: { status: "failed", failureReason: "invalid_output: not_json", factCount: 0, appliedChunkCount: 0 },
    });

    await workspace.reprocess(documentId, { override: "on", reply: { kind: "failure" } });
    expectDatedEverywhere(workspace, documentId, OPERATOR_DATES);

    await workspace.reprocess(documentId, {});
    expectDatedEverywhere(workspace, documentId, OPERATOR_DATES);
  });
});

describe("extraction-written event dates", () => {
  const createExtractedDocument = async (workspace: ReturnType<typeof buildCalendarWorkspace>): Promise<string> => {
    const documentId = await workspace.createDocument({ override: "on", reply: { kind: "dates", ...OPERATOR_DATES } });
    expectDatedEverywhere(workspace, documentId, OPERATOR_DATES);
    expect(workspace.documentOf(documentId)?.enrichment).toMatchObject({
      status: "applied",
      generatedKeys: ["dateFrom", "dateTo"],
      dateOwnershipRecorded: true,
    });
    return documentId;
  };

  it("clear when the content changes and extraction does not run on the new revision", async () => {
    const workspace = buildCalendarWorkspace();
    const documentId = await createExtractedDocument(workspace);

    await workspace.put(documentId, { content: RESCHEDULED_COURSE });

    expect(workspace.documentOf(documentId)?.metadata).not.toHaveProperty("dateFrom");
    expect(workspace.documentOf(documentId)?.metadata).not.toHaveProperty("dateTo");
    for (const metadata of workspace.chunkMetadataOf(documentId)) {
      expect(metadata).not.toHaveProperty("dateFrom");
    }
    expect(workspace.documentOf(documentId)?.enrichment).toBeNull();
  });

  it("stay through a failed run on a new revision until a run replaces them", async () => {
    const workspace = buildCalendarWorkspace();
    const documentId = await createExtractedDocument(workspace);

    await workspace.put(documentId, { content: RESCHEDULED_COURSE, override: "on", reply: { kind: "failure" } });

    expectDatedEverywhere(workspace, documentId, OPERATOR_DATES);
    expect(workspace.documentOf(documentId)?.enrichment).toMatchObject({
      status: "failed",
      generatedKeys: ["dateFrom", "dateTo"],
    });

    await workspace.reprocess(documentId, { override: "on", reply: { kind: "dates", ...MODEL_DATES } });
    expectDatedEverywhere(workspace, documentId, MODEL_DATES);
  });

  it("stay extraction's through a failed run under provenance recorded before date ownership", async () => {
    const workspace = buildCalendarWorkspace();
    const documentId = await workspace.createDocument({});
    const current = workspace.documentOf(documentId)!;
    // An applied event run that dated a chunk wrote these dates.
    workspace.documentRepository.items.set(documentId, {
      ...current,
      metadata: { ...MODEL_DATES },
      enrichment: { status: "applied", shape: "event", factCount: 1, appliedChunkCount: 2 },
    });

    await workspace.reprocess(documentId, { override: "on", reply: { kind: "failure" } });
    expectDatedEverywhere(workspace, documentId, MODEL_DATES);
    expect(workspace.documentOf(documentId)?.enrichment).toMatchObject({
      status: "failed",
      generatedKeys: ["dateFrom", "dateTo"],
      dateOwnershipRecorded: true,
    });

    await workspace.reprocess(documentId, {});
    expect(workspace.documentOf(documentId)?.metadata).not.toHaveProperty("dateFrom");
    for (const metadata of workspace.chunkMetadataOf(documentId)) {
      expect(metadata).not.toHaveProperty("dateFrom");
    }
  });

  it("become the operator's when a manual edit changes either one", async () => {
    const workspace = buildCalendarWorkspace({ workspaceExtractionEnabled: true });
    const documentId = await createExtractedDocument(workspace);
    const corrected = { dateFrom: OPERATOR_DATES.dateFrom, dateTo: "2026-03-07" };

    // The edit queues a revision that extraction runs on, and the model reads other dates.
    await workspace.editMetadata(documentId, corrected, { kind: "dates", ...MODEL_DATES });

    expectDatedEverywhere(workspace, documentId, corrected);
    expect(workspace.documentOf(documentId)?.enrichment).toMatchObject({ status: "applied", generatedKeys: [] });
  });
});
