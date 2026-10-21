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
  InMemoryDocumentSourceRepository,
} from "../support/fakes.js";
import { createDocumentEmbeddingPort } from "../support/embeddingPorts.js";

const WORKSPACE_ID = "workspace-calendar";

type Dates = { dateFrom: string; dateTo: string };

// The operator's hand-written span for the whole programme.
const OPERATOR_DATES: Dates = { dateFrom: "2026-03-02", dateTo: "2026-03-13" };

// One paragraph per retreat week, so each week lands on its own chunk.
const programme = (weekOne: string, weekTwo: string): string =>
  `Meditation retreats for returning students.\n\nWeek one retreat: ${weekOne}.\n\nWeek two retreat: ${weekTwo}.`;
const MARCH_PROGRAMME = programme("2 to 6 March 2026", "9 to 13 March 2026");
const MAY_PROGRAMME = programme("4 to 8 May 2026", "11 to 15 May 2026");

interface ExtractedEvent extends Dates {
  quote: string;
}
const MARCH_EVENTS: ExtractedEvent[] = [
  { quote: "Week one retreat", dateFrom: "2026-03-02", dateTo: "2026-03-06" },
  { quote: "Week two retreat", dateFrom: "2026-03-09", dateTo: "2026-03-13" },
];
const MAY_EVENTS: ExtractedEvent[] = [
  { quote: "Week one retreat", dateFrom: "2026-05-04", dateTo: "2026-05-08" },
  { quote: "Week two retreat", dateFrom: "2026-05-11", dateTo: "2026-05-15" },
];

type ModelReply = { kind: "events"; events: ExtractedEvent[] } | { kind: "failure" };
const reads = (events: ExtractedEvent[]): ModelReply => ({ kind: "events", events });
const FAILS: ModelReply = { kind: "failure" };

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

// The model cites each event by the representation offsets of its quote.
const scriptedGateway = (script: { next: ModelReply }): DocumentEnrichmentGateway => ({
  async generate({ documentRepresentation }) {
    const reply = script.next;
    if (reply.kind === "failure") {
      throw new Error("provider unavailable");
    }
    return {
      model: "gpt-5-mini",
      output: {
        type: "event",
        confidence: 0.92,
        facts: reply.events.map((event, index) => {
          const start = documentRepresentation.indexOf(event.quote);
          return {
            id: `week-${index + 1}`,
            kind: "event_date",
            label: event.quote,
            dateFrom: event.dateFrom,
            dateTo: event.dateTo,
            sourceRange: { start, end: start + event.quote.length },
          };
        }),
      },
    };
  },
});

const buildCalendarWorkspace = (options: { workspaceExtractionEnabled?: boolean } = {}) => {
  const documentRepository = new InMemoryDocumentRepository();
  const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
  documentRepository.setJobRepository(jobRepository);
  const chunkRepository = new InMemoryChunkRepository(documentRepository);
  const sourceRepository = new InMemoryDocumentSourceRepository();
  sourceRepository.setDocumentRepository(documentRepository);
  const auditService = createAuditService();
  const model: { next: ModelReply } = { next: FAILS };

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
    sourceRepository,
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
    model.next = input.reply ?? FAILS;
    const created = await ingestion.ingest({
      workspaceId: WORKSPACE_ID,
      title: "Meditation retreats",
      content: MARCH_PROGRAMME,
      metadata: input.metadata,
      documentEnrichmentOverride: input.override,
    });
    await drain();
    return created.documentId;
  };

  const createSourcedDocument = async (input: {
    sourceDocumentMetadata: Record<string, unknown>;
    override?: "on" | "off";
    reply?: ModelReply;
  }): Promise<{ documentId: string; sourceId: string }> => {
    const source = await sourceRepository.upsertByExternalId({
      workspaceId: WORKSPACE_ID,
      kind: "website",
      name: "Retreat calendar",
      externalId: "retreat-calendar",
      config: { documentMetadata: input.sourceDocumentMetadata },
    });
    model.next = input.reply ?? FAILS;
    const document = await documentRepository.createAndQueue(
      {
        workspaceId: WORKSPACE_ID,
        title: "Meditation retreats",
        sourceContent: MARCH_PROGRAMME,
        markdownContent: MARCH_PROGRAMME,
        sourceId: source.id,
      },
      input.override ? { documentEnrichmentOverride: input.override } : null,
    );
    await drain();
    return { documentId: document.id, sourceId: source.id };
  };

  const setSourceDocumentMetadata = (sourceId: string, documentMetadata: Record<string, unknown>): void => {
    const source = sourceRepository.items.get(sourceId)!;
    sourceRepository.items.set(sourceId, { ...source, config: { ...source.config, documentMetadata } });
  };

  const put = async (documentId: string, input: {
    content?: string;
    metadata?: Record<string, unknown>;
    override?: "on" | "off";
    reply?: ModelReply;
  }): Promise<void> => {
    model.next = input.reply ?? FAILS;
    await ingestion.update({
      workspaceId: WORKSPACE_ID,
      documentId,
      title: "Meditation retreats",
      content: input.content ?? MARCH_PROGRAMME,
      metadata: input.metadata,
      documentEnrichmentOverride: input.override,
    });
    await drain();
  };

  const reprocess = async (documentId: string, input: { override?: "on" | "off"; reply?: ModelReply } = {}): Promise<void> => {
    model.next = input.reply ?? FAILS;
    await ingestion.reprocess({ workspaceId: WORKSPACE_ID, documentId, documentEnrichmentOverride: input.override });
    await drain();
  };

  const editMetadata = async (documentId: string, metadata: Record<string, unknown>, reply?: ModelReply): Promise<void> => {
    model.next = reply ?? FAILS;
    await ingestion.updateRetrievalSettings({ workspaceId: WORKSPACE_ID, documentId, metadata });
    await drain();
  };

  const setStoredState = (documentId: string, state: { metadata: Record<string, unknown>; enrichment: Record<string, unknown> }): void => {
    const current = documentRepository.items.get(documentId)!;
    documentRepository.items.set(documentId, {
      ...current,
      metadata: state.metadata,
      enrichment: state.enrichment as never,
    });
  };

  const documentOf = (documentId: string) => documentRepository.items.get(documentId);
  const publishedDocument = (documentId: string) => ingestion.getDocument(WORKSPACE_ID, documentId);
  const chunksOf = (documentId: string) =>
    [...(chunkRepository.items.get(documentId) ?? [])]
      .sort((left, right) => left.chunkIndex - right.chunkIndex)
      .map((chunk) => ({ metadata: chunk.metadata ?? {}, searchText: chunk.searchText }));
  const enrichmentAudits = () => auditService.events.filter((event) => event.eventType === "document.enrichment");

  return {
    createDocument,
    createSourcedDocument,
    setSourceDocumentMetadata,
    put,
    reprocess,
    editMetadata,
    setStoredState,
    documentOf,
    publishedDocument,
    chunksOf,
    enrichmentAudits,
  };
};

type CalendarWorkspace = ReturnType<typeof buildCalendarWorkspace>;

/** Hand-written dates sit on every chunk and in every chunk's embedded search text. */
const expectDatesOnEveryChunk = (workspace: CalendarWorkspace, documentId: string, dates: Dates): void => {
  const chunks = workspace.chunksOf(documentId);
  expect(chunks).toHaveLength(3);
  for (const chunk of chunks) {
    expect(chunk.metadata).toMatchObject(dates);
    expect(chunk.searchText).toContain(`Date from: ${dates.dateFrom}`);
    expect(chunk.searchText).toContain(`Date to: ${dates.dateTo}`);
  }
};

const expectOperatorDates = (workspace: CalendarWorkspace, documentId: string, dates: Dates): void => {
  expect(workspace.documentOf(documentId)?.metadata).toMatchObject(dates);
  expectDatesOnEveryChunk(workspace, documentId, dates);
};

/** No chunk carries a date, in its metadata or in the text it was embedded from. */
const expectUndatedChunks = (workspace: CalendarWorkspace, documentId: string): void => {
  for (const chunk of workspace.chunksOf(documentId)) {
    expect(chunk.metadata).not.toHaveProperty("dateFrom");
    expect(chunk.metadata).not.toHaveProperty("dateTo");
    expect(chunk.searchText).not.toContain("Date from:");
    expect(chunk.searchText).not.toContain("Month label:");
  }
};

/**
 * Extracted dates: the document carries the overall span, each retreat's chunk
 * carries that retreat's dates, and none of it was folded into the embedded text.
 */
const expectExtractedEventDates = (workspace: CalendarWorkspace, documentId: string, events: ExtractedEvent[]): void => {
  const [first, second] = events;
  expect(workspace.documentOf(documentId)?.metadata).toMatchObject({ dateFrom: first.dateFrom, dateTo: second.dateTo });
  const [intro, weekOne, weekTwo] = workspace.chunksOf(documentId);
  // The introduction describes no retreat; an empty tag the operator left on it is not a date.
  expect(intro?.metadata.dateFrom || null).toBeNull();
  expect(weekOne?.metadata).toMatchObject({ dateFrom: first.dateFrom, dateTo: first.dateTo });
  expect(weekTwo?.metadata).toMatchObject({ dateFrom: second.dateFrom, dateTo: second.dateTo });
  for (const chunk of [intro, weekOne, weekTwo]) {
    expect(chunk?.searchText).not.toContain("Date from:");
    expect(chunk?.searchText).not.toContain("Month label:");
  }
};

describe("operator-written event dates", () => {
  it("survive a failed run, a PUT, and a reprocess without an override", async () => {
    const workspace = buildCalendarWorkspace();
    const documentId = await workspace.createDocument({ metadata: OPERATOR_DATES, override: "on", reply: FAILS });
    expect(workspace.documentOf(documentId)?.enrichment).toMatchObject({ status: "failed" });
    expectOperatorDates(workspace, documentId, OPERATOR_DATES);

    await workspace.put(documentId, { metadata: OPERATOR_DATES });
    expectOperatorDates(workspace, documentId, OPERATOR_DATES);

    await workspace.reprocess(documentId, { override: "off" });
    expectOperatorDates(workspace, documentId, OPERATOR_DATES);
  });

  it("survive a PUT with extraction forced on whose run fails", async () => {
    const workspace = buildCalendarWorkspace();
    const documentId = await workspace.createDocument({ metadata: OPERATOR_DATES, override: "on", reply: FAILS });

    await workspace.put(documentId, { metadata: OPERATOR_DATES, override: "on", reply: FAILS });

    expectOperatorDates(workspace, documentId, OPERATOR_DATES);
    expect(workspace.documentOf(documentId)?.enrichment).toMatchObject({ status: "failed" });
  });

  it("win over the per-event dates a successful run reads", async () => {
    const workspace = buildCalendarWorkspace();
    const documentId = await workspace.createDocument({ metadata: OPERATOR_DATES, override: "on", reply: reads(MAY_EVENTS) });

    expectOperatorDates(workspace, documentId, OPERATOR_DATES);
    const enrichment = workspace.documentOf(documentId)?.enrichment;
    expect(enrichment).toMatchObject({ status: "applied", generatedKeys: [], appliedChunkCount: 0 });
    expect(enrichment?.fieldCounts?.skippedCollision).toBe(2);
    expect(workspace.enrichmentAudits().at(-1)?.metadata).toMatchObject({ status: "applied", skippedCollisionCount: 2 });

    await workspace.reprocess(documentId, { override: "on", reply: reads(MAY_EVENTS) });
    expectOperatorDates(workspace, documentId, OPERATOR_DATES);

    await workspace.reprocess(documentId, { override: "off" });
    expectOperatorDates(workspace, documentId, OPERATOR_DATES);
  });

  it("report no collisions for a failed run that follows one that skipped them", async () => {
    const workspace = buildCalendarWorkspace();
    const documentId = await workspace.createDocument({ metadata: OPERATOR_DATES, override: "on", reply: reads(MAY_EVENTS) });

    await workspace.reprocess(documentId, { override: "on", reply: FAILS });

    expect(workspace.enrichmentAudits().at(-1)?.metadata).toMatchObject({ status: "failed", skippedCollisionCount: 0 });
  });

  it("survive under recorded provenance of a failed run that never tracked date ownership", async () => {
    const workspace = buildCalendarWorkspace();
    const documentId = await workspace.createDocument({ metadata: OPERATOR_DATES });
    workspace.setStoredState(documentId, {
      metadata: OPERATOR_DATES,
      enrichment: { status: "failed", failureReason: "invalid_output: not_json", factCount: 0, appliedChunkCount: 0 },
    });

    await workspace.reprocess(documentId, { override: "on", reply: FAILS });
    expectOperatorDates(workspace, documentId, OPERATOR_DATES);

    await workspace.reprocess(documentId);
    expectOperatorDates(workspace, documentId, OPERATOR_DATES);
  });

  it("become the operator's again once sent back over an applied run that never tracked date ownership", async () => {
    const workspace = buildCalendarWorkspace();
    const documentId = await workspace.createDocument({ metadata: OPERATOR_DATES });
    // The run read the same span and wrote it over the operator's dates.
    workspace.setStoredState(documentId, {
      metadata: OPERATOR_DATES,
      enrichment: { status: "applied", shape: "event", factCount: 2, appliedChunkCount: 2 },
    });

    await workspace.put(documentId, { metadata: OPERATOR_DATES });
    expectOperatorDates(workspace, documentId, OPERATOR_DATES);

    await workspace.reprocess(documentId);
    expectOperatorDates(workspace, documentId, OPERATOR_DATES);

    await workspace.reprocess(documentId, { override: "on", reply: reads(MAY_EVENTS) });
    expectOperatorDates(workspace, documentId, OPERATOR_DATES);
  });

  it("do not count when they are empty", async () => {
    const workspace = buildCalendarWorkspace();
    const documentId = await workspace.createDocument({
      metadata: { dateFrom: "", dateTo: null },
      override: "on",
      reply: reads(MARCH_EVENTS),
    });

    expectExtractedEventDates(workspace, documentId, MARCH_EVENTS);
    expect(workspace.documentOf(documentId)?.enrichment).toMatchObject({ generatedKeys: ["dateFrom", "dateTo"] });
  });
});

describe("source-level dates", () => {
  it("stay on every chunk when a run reads other dates", async () => {
    const workspace = buildCalendarWorkspace();
    const { documentId } = await workspace.createSourcedDocument({
      sourceDocumentMetadata: OPERATOR_DATES,
      override: "on",
      reply: reads(MAY_EVENTS),
    });

    expectDatesOnEveryChunk(workspace, documentId, OPERATOR_DATES);
    expect(workspace.documentOf(documentId)?.metadata).not.toHaveProperty("dateFrom");
    expect(workspace.documentOf(documentId)?.enrichment).toMatchObject({ generatedKeys: [] });
    expect(workspace.documentOf(documentId)?.enrichment?.fieldCounts?.skippedCollision).toBe(2);

    await workspace.reprocess(documentId, { override: "on", reply: reads(MAY_EVENTS) });
    expectDatesOnEveryChunk(workspace, documentId, OPERATOR_DATES);
  });

  it("stay on every chunk once dates extraction wrote earlier come off", async () => {
    const workspace = buildCalendarWorkspace();
    const { documentId, sourceId } = await workspace.createSourcedDocument({
      sourceDocumentMetadata: {},
      override: "on",
      reply: reads(MARCH_EVENTS),
    });
    expectExtractedEventDates(workspace, documentId, MARCH_EVENTS);
    workspace.setSourceDocumentMetadata(sourceId, OPERATOR_DATES);

    await workspace.reprocess(documentId, { override: "on", reply: FAILS });
    expectDatesOnEveryChunk(workspace, documentId, OPERATOR_DATES);

    await workspace.reprocess(documentId, { override: "on", reply: reads(MAY_EVENTS) });
    expectDatesOnEveryChunk(workspace, documentId, OPERATOR_DATES);
    expect(workspace.documentOf(documentId)?.metadata).not.toHaveProperty("dateFrom");

    await workspace.reprocess(documentId, { override: "off" });
    expectDatesOnEveryChunk(workspace, documentId, OPERATOR_DATES);
  });
});

describe("extraction-written event dates", () => {
  const createExtractedDocument = async (workspace: CalendarWorkspace): Promise<string> => {
    const documentId = await workspace.createDocument({ override: "on", reply: reads(MARCH_EVENTS) });
    expectExtractedEventDates(workspace, documentId, MARCH_EVENTS);
    expect(workspace.documentOf(documentId)?.enrichment).toMatchObject({
      status: "applied",
      generatedKeys: ["dateFrom", "dateTo"],
    });
    return documentId;
  };

  it("publish their ownership through the generated keys alone", async () => {
    const workspace = buildCalendarWorkspace();
    const documentId = await createExtractedDocument(workspace);

    const published = await workspace.publishedDocument(documentId);

    expect(published.enrichment).toMatchObject({ generatedKeys: ["dateFrom", "dateTo"] });
    expect(published.enrichment).not.toHaveProperty("dateOwnershipRecorded");
  });

  it("clear when the content changes and extraction does not run on the new revision", async () => {
    const workspace = buildCalendarWorkspace();
    const documentId = await createExtractedDocument(workspace);

    await workspace.put(documentId, { content: MAY_PROGRAMME });

    expect(workspace.documentOf(documentId)?.metadata).not.toHaveProperty("dateFrom");
    expect(workspace.documentOf(documentId)?.metadata).not.toHaveProperty("dateTo");
    expectUndatedChunks(workspace, documentId);
    expect(workspace.documentOf(documentId)?.enrichment).toBeNull();
  });

  it("stay on the document through a failed run without reaching the new revision's chunks", async () => {
    const workspace = buildCalendarWorkspace();
    const documentId = await createExtractedDocument(workspace);

    await workspace.put(documentId, { content: MAY_PROGRAMME, override: "on", reply: FAILS });

    expect(workspace.documentOf(documentId)?.metadata).toMatchObject({ dateFrom: "2026-03-02", dateTo: "2026-03-13" });
    expectUndatedChunks(workspace, documentId);
    expect(workspace.documentOf(documentId)?.enrichment).toMatchObject({
      status: "failed",
      generatedKeys: ["dateFrom", "dateTo"],
    });

    await workspace.reprocess(documentId, { override: "on", reply: reads(MAY_EVENTS) });
    expectExtractedEventDates(workspace, documentId, MAY_EVENTS);
  });

  it("give way to the new revision's per-event dates when its run succeeds", async () => {
    const workspace = buildCalendarWorkspace();
    const documentId = await createExtractedDocument(workspace);

    await workspace.put(documentId, { content: MAY_PROGRAMME, override: "on", reply: reads(MAY_EVENTS) });

    expectExtractedEventDates(workspace, documentId, MAY_EVENTS);
  });

  it("stay extraction's through a failed run under provenance that never tracked date ownership", async () => {
    const workspace = buildCalendarWorkspace();
    const documentId = await workspace.createDocument({});
    // An applied event run that dated a chunk wrote these dates.
    workspace.setStoredState(documentId, {
      metadata: { dateFrom: "2026-03-02", dateTo: "2026-03-13" },
      enrichment: { status: "applied", shape: "event", factCount: 2, appliedChunkCount: 2 },
    });

    await workspace.reprocess(documentId, { override: "on", reply: FAILS });
    expect(workspace.documentOf(documentId)?.metadata).toMatchObject({ dateFrom: "2026-03-02", dateTo: "2026-03-13" });
    expectUndatedChunks(workspace, documentId);
    expect(workspace.documentOf(documentId)?.enrichment).toMatchObject({
      status: "failed",
      generatedKeys: ["dateFrom", "dateTo"],
    });

    await workspace.reprocess(documentId);
    expect(workspace.documentOf(documentId)?.metadata).not.toHaveProperty("dateFrom");
    expectUndatedChunks(workspace, documentId);
  });

  it("become the operator's when a manual edit changes either one", async () => {
    const workspace = buildCalendarWorkspace({ workspaceExtractionEnabled: true });
    const documentId = await createExtractedDocument(workspace);
    const corrected = { dateFrom: "2026-03-02", dateTo: "2026-03-14" };

    // The edit queues a revision that extraction runs on, and the model reads other dates.
    await workspace.editMetadata(documentId, corrected, reads(MAY_EVENTS));

    expectOperatorDates(workspace, documentId, corrected);
    expect(workspace.documentOf(documentId)?.enrichment).toMatchObject({ status: "applied", generatedKeys: [] });
  });
});
