import { createHash, randomUUID } from "node:crypto";

import type { AuditService } from "../../audit/contracts/index.js";
import type {
  DocumentProcessingJobRecord,
  DocumentProcessingJobRepositoryPort,
} from "../../../db/repositories/documentProcessingJobRepository.js";
import {
  deriveChunkSection,
  deriveDocumentSubject,
  normalizeMarkdown,
  renderMetadataSearchText,
  renderSearchText,
  type ChunkingStrategy,
  type ChunkingStrategyId,
} from "../../retrieval/public.js";
import type {
  DocumentEmbeddingPort,
  EmbeddingSpaceRef,
} from "../../embeddingProfiles/contracts/embeddingConsumers.js";
import type { IngestionSettingsRecord } from "../../settings/contracts/ingestion.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import { traceOperation } from "../../../shared/observability/tracing/operations.js";
import {
  parseDocumentEnrichmentOverride,
  parseDocumentSourceEnrichmentOverride,
  resolveDocumentEnrichmentEnablement,
} from "../domain/enrichment/enrichmentEnablement.js";
import type {
  ChunkMetadataRevisionPatch,
  ChunkRecord,
  ChunkRepositoryPort,
  DocumentRepositoryPort,
} from "../contracts/documentContracts.js";
import type {
  DocumentEnrichmentStagePort,
  DocumentEnrichmentStageResult,
} from "./documentEnrichmentService.js";
import { NoopDocumentJobDispatcher, type DocumentJobDispatcherPort } from "./documentJobDispatcher.js";
import type { MaterializedDocumentContent } from "./documentSourceContentService.js";
import type { DocumentSourceRepositoryPort } from "../../../db/repositories/documentSourceRepository.js";

export interface IngestionSettingsReaderPort {
  getForWorkspace(workspaceId: string): Promise<IngestionSettingsRecord>;
  promotePendingEmbeddingModelIfReady?(workspaceId: string): Promise<IngestionSettingsRecord | null>;
}

export interface ChunkingStrategyRegistryPort {
  get(strategyId: ChunkingStrategyId): ChunkingStrategy;
}

export type DocumentProcessingOutcome = "completed" | "stale" | "deleted";

// The processing service only needs to create the follow-up enrich job; it never
// claims or fails jobs (the worker owns that lifecycle). ensureEnrichJob is
// idempotent so a vectorize retry cannot double-insert.
export type EnrichJobEnqueuePort = Pick<DocumentProcessingJobRepositoryPort, "ensureEnrichJob">;

export interface DocumentSourceContentServicePort {
  materialize(document: {
    id: string;
    workspaceId: string;
    title: string;
    sourceContent: string;
    markdownContent: string;
    status: string;
    revision: number;
    metadata: Record<string, unknown>;
    sourceKind: "inline_text" | "uploaded_file";
    sourceFilename?: string | null;
    sourceMimeType?: string | null;
    sourceStorageBucket?: string | null;
    sourceStorageObject?: string | null;
    sourceStorageGeneration?: string | null;
    sourceSizeBytes?: number | null;
    createdAt: Date;
    updatedAt: Date;
  }): Promise<MaterializedDocumentContent>;
}

const inlineDocumentSourceContentService: DocumentSourceContentServicePort = {
  async materialize(document) {
    return {
      sourceContent: document.sourceContent,
      markdownContent: document.markdownContent,
    };
  },
};

type TraceAttributes = Record<string, unknown>;

const traceActiveSpan = <T>(
  name: string,
  attributes: TraceAttributes,
  run: () => Promise<T> | T,
  resultAttributes?: (result: T) => TraceAttributes,
): Promise<T> => traceOperation({ name, attributes, run, resultAttributes });

const boundedTraceCount = (value: number | undefined): number =>
  Math.min(1_000, Math.max(0, value ?? 0));

const compactTraceAttributes = (attributes: TraceAttributes): TraceAttributes =>
  Object.fromEntries(
    Object.entries(attributes).filter(([, value]) => value !== undefined && value !== null),
  ) as TraceAttributes;

export const stripStaleEnrichmentMetadata = (
  metadata: Record<string, unknown>,
  hadEnrichment: boolean,
): Record<string, unknown> => {
  if (!hadEnrichment) {
    return metadata;
  }

  const {
    enrichment: _enrichment,
    dateFrom: _dateFrom,
    dateTo: _dateTo,
    ...rest
  } = metadata;
  return rest;
};

export const buildDocumentProcessingTraceAttributes = (
  job: Pick<DocumentProcessingJobRecord, "id" | "workspaceId" | "documentId" | "documentRevision" | "attemptCount" | "status" | "kind">,
  input: {
    stage?: "claim" | "materialize" | "chunking" | "enrichment" | "embedding" | "storage" | "audit" | "complete";
    outcome?: DocumentProcessingOutcome | "completed" | "published";
    chunkCount?: number;
    enrichmentStatus?: string;
    enrichmentShape?: string;
    enrichmentFactCount?: number;
    enrichmentAppliedChunkCount?: number;
  } = {},
): TraceAttributes => compactTraceAttributes({
  "radioso.workspace_id": job.workspaceId,
  "radioso.document_id": job.documentId,
  "radioso.job_id": job.id,
  "document.revision": job.documentRevision,
  "document.job.id": job.id,
  "document.job.kind": job.kind,
  "document.job.attempt_count": job.attemptCount,
  "document.job.status": job.status,
  "document.processing.stage": input.stage,
  "document.processing.outcome": input.outcome,
  "document.processing.item.count": input.chunkCount === undefined ? undefined : boundedTraceCount(input.chunkCount),
  "document.enrichment.status": input.enrichmentStatus,
  "document.enrichment.shape": input.enrichmentShape,
  "document.enrichment.fact_count": input.enrichmentFactCount,
  "document.enrichment.applied_chunk_count": input.enrichmentAppliedChunkCount,
});

export class DocumentProcessingService {
  constructor(
    private readonly documentRepository: DocumentRepositoryPort,
    private readonly chunkRepository: ChunkRepositoryPort,
    private readonly documentEmbeddings: DocumentEmbeddingPort,
    private readonly auditService: AuditService,
    private readonly ingestionSettingsService: IngestionSettingsReaderPort,
    private readonly chunkingStrategyRegistry: ChunkingStrategyRegistryPort,
    private readonly documentSourceContentService: DocumentSourceContentServicePort = inlineDocumentSourceContentService,
    private readonly logger?: AppLogger,
    private readonly documentEnrichmentStage?: DocumentEnrichmentStagePort,
    private readonly documentSourceRepository?: Pick<DocumentSourceRepositoryPort, "findByIdAndWorkspaceId">,
    private readonly jobRepository?: EnrichJobEnqueuePort,
    private readonly jobDispatcher: DocumentJobDispatcherPort = new NoopDocumentJobDispatcher(),
  ) {}

  async process(job: DocumentProcessingJobRecord): Promise<DocumentProcessingOutcome> {
    return traceActiveSpan("document.processing.process", buildDocumentProcessingTraceAttributes(job), async () => {
      const markedProcessing = await traceActiveSpan("document.processing.claim", buildDocumentProcessingTraceAttributes(job, {
        stage: "claim",
      }), () => this.documentRepository.setStatusIfRevisionMatches({
        documentId: job.documentId,
        workspaceId: job.workspaceId,
        revision: job.documentRevision,
        status: "processing",
        failureReason: null,
      }));

      if (!markedProcessing) {
        const document = await this.documentRepository.findByIdAndWorkspaceId(job.documentId, job.workspaceId);
        return document ? "stale" : "deleted";
      }

      const materializedContent = await traceActiveSpan(
        "document.processing.materialize",
        buildDocumentProcessingTraceAttributes(job, { stage: "materialize" }),
        () => this.documentSourceContentService.materialize(markedProcessing),
      );
      const documentWithContent =
        materializedContent.sourceContent !== markedProcessing.sourceContent ||
        materializedContent.markdownContent !== markedProcessing.markdownContent
          ? await traceActiveSpan("document.processing.materialize.store", buildDocumentProcessingTraceAttributes(job, {
              stage: "materialize",
            }), () => this.documentRepository.updateDerivedContentForRevision({
              documentId: markedProcessing.id,
              workspaceId: job.workspaceId,
              revision: job.documentRevision,
              sourceContent: materializedContent.sourceContent,
              markdownContent: materializedContent.markdownContent,
            }))
          : markedProcessing;

      if (!documentWithContent) {
        const currentDocument = await this.documentRepository.findByIdAndWorkspaceId(job.documentId, job.workspaceId);
        return currentDocument ? "stale" : "deleted";
      }

      const documentSubject = deriveDocumentSubject({
        title: documentWithContent.title,
        content: normalizeMarkdown(documentWithContent.sourceContent),
      });
      const settings = await this.ingestionSettingsService.getForWorkspace(job.workspaceId);
      // Canonical publication always belongs to the active profile. A pending
      // profile is populated only by generation-pinned embedding_profile jobs.
      const embeddingModel = settings.embeddingModel;
      const chunkingStrategy = this.chunkingStrategyRegistry.get(settings.chunkingStrategy);
      const chunkingStartedAt = Date.now();
      const chunks = await traceActiveSpan("document.processing.chunking", buildDocumentProcessingTraceAttributes(job, {
        stage: "chunking",
      }), () => chunkingStrategy.chunk({
        title: documentWithContent.title,
        content: documentWithContent.markdownContent,
        config: {
          fixedWindowChunkSize: settings.fixedWindowChunkSize,
          fixedWindowChunkOverlap: settings.fixedWindowChunkOverlap,
          structuredMinChunkSize: settings.structuredMinChunkSize,
          structuredMaxChunkSize: settings.structuredMaxChunkSize,
          embeddingUsageContext: {
            workspaceId: job.workspaceId,
            requestId: job.id,
            surface: "documents",
            attemptKey: `document:${job.documentId}:${job.documentRevision}:${job.id}`,
          },
        },
      }), (result) => buildDocumentProcessingTraceAttributes(job, {
        stage: "chunking",
        chunkCount: result.length,
      }));
      const chunkingDurationMs = Math.max(0, Date.now() - chunkingStartedAt);
      // Enrichment (LLM metadata extraction) is no longer folded into this
      // vectorize path — it runs afterward as a lower-priority enrich job so the
      // document becomes queryable as soon as its embeddings are published. A
      // fresh vectorization starts from clean base metadata (any prior extracted
      // dates/provenance are stripped and re-derived by the follow-up enrich job).
      const hadPriorEnrichment = Boolean(documentWithContent.enrichment);
      const baseDocumentMetadata = stripStaleEnrichmentMetadata(documentWithContent.metadata ?? {}, hadPriorEnrichment);
      if (hadPriorEnrichment) {
        const updatedDocument = await this.documentRepository.updateMetadataForRevision({
          documentId: documentWithContent.id,
          workspaceId: job.workspaceId,
          revision: job.documentRevision,
          metadata: baseDocumentMetadata,
          enrichment: null,
        });
        if (!updatedDocument) {
          return "stale";
        }
      }
      const enrichedChunks = chunks.map((chunk) => {
        const metadataSearchText = renderMetadataSearchText(baseDocumentMetadata);
        return {
          ...chunk,
          metadata: baseDocumentMetadata,
          searchText: renderSearchText({
            title: documentWithContent.title,
            subjectLabel: documentSubject,
            sectionPath: deriveChunkSection(chunk.content),
            attributeText: metadataSearchText,
            content: chunk.content,
          }),
        };
      });
      const embeddingUsage = this.buildEmbeddingUsage(job, enrichedChunks);
      const embeddingStartedAt = Date.now();
      let embeddings: number[][];
      let embeddingSpace: EmbeddingSpaceRef;
      try {
        const embeddingResult = await traceActiveSpan("document.processing.embedding", buildDocumentProcessingTraceAttributes(job, {
          stage: "embedding",
          chunkCount: enrichedChunks.length,
        }), () => this.documentEmbeddings.embedDocumentChunks({
          workspaceId: job.workspaceId,
          texts: enrichedChunks.map((chunk) => chunk.searchText),
          sourceId: documentWithContent.sourceId ?? null,
          documentId: job.documentId,
          documentRevision: job.documentRevision,
          jobId: job.id,
          usageItems: embeddingUsage.chunks,
          usageContext: {
            workspaceId: job.workspaceId,
            requestId: job.id,
            surface: "documents",
            operation: "embedding",
            attemptKey: embeddingUsage.attemptKey,
          },
        }), (result) => buildDocumentProcessingTraceAttributes(job, {
          stage: "embedding",
          chunkCount: result.vectors.length,
        }));
        embeddings = embeddingResult.vectors.map((vector) => [...vector]);
        embeddingSpace = embeddingResult.space;
      } catch (error) {
        throw error;
      }
      const storageEmbeddingDurationMs = Math.max(0, Date.now() - embeddingStartedAt);
      this.logger?.info(
        {
          role: "worker",
          workspaceId: job.workspaceId,
          documentId: documentWithContent.id,
          revision: job.documentRevision,
          chunkingStrategy: settings.chunkingStrategy,
          embeddingModel,
          chunkCount: enrichedChunks.length,
          chunkingDurationMs,
          storageEmbeddingDurationMs,
        },
        "Document processing embeddings completed",
      );
      const persistedChunks: ChunkRecord[] = enrichedChunks.map((chunk, index) => ({
        id: randomUUID(),
        documentId: documentWithContent.id,
        workspaceId: job.workspaceId,
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        searchText: chunk.searchText,
        embedding: embeddings[index] ?? [],
        embeddingModel,
        startOffset: chunk.startOffset,
        endOffset: chunk.endOffset,
        metadata: chunk.metadata ?? baseDocumentMetadata,
        createdAt: new Date(),
      }));

      const published = await traceActiveSpan("document.processing.storage", buildDocumentProcessingTraceAttributes(job, {
        stage: "storage",
        chunkCount: persistedChunks.length,
      }), () => this.chunkRepository.publishForDocumentRevision({
        documentId: documentWithContent.id,
        workspaceId: job.workspaceId,
        revision: job.documentRevision,
        chunks: persistedChunks,
        embeddingSpace,
        canonicalVersion: String(job.documentRevision),
      }), (result) => buildDocumentProcessingTraceAttributes(job, {
        stage: "storage",
        outcome: result ? "published" : undefined,
        chunkCount: persistedChunks.length,
      }));

      if (!published) {
        const currentDocument = await this.documentRepository.findByIdAndWorkspaceId(job.documentId, job.workspaceId);
        return currentDocument ? "stale" : "deleted";
      }

      // The document is now queryable. Decide whether metadata extraction should
      // follow; the enrich job itself is enqueued last (see below).
      const enrichmentEnabled = await this.resolveEnrichmentEnabled(job, {
        sourceId: documentWithContent.sourceId ?? null,
        workspaceId: job.workspaceId,
        settings,
      });

      await traceActiveSpan("document.processing.audit", buildDocumentProcessingTraceAttributes(job, {
        stage: "audit",
        outcome: "completed",
      }), () => this.auditService.record({
        workspaceId: job.workspaceId,
        eventType: "document.process",
        eventStatus: "success",
        metadata: {
          documentId: documentWithContent.id,
          revision: job.documentRevision,
          enrichmentStatus: enrichmentEnabled ? "pending" : "skipped",
        },
      }));
      await this.ingestionSettingsService.promotePendingEmbeddingModelIfReady?.(job.workspaceId);

      // Enqueue the follow-up enrich job as the final step. Nothing may run after
      // it: if a later statement threw, the vectorize job would retry, re-run
      // process(), and hit the (document_id, revision, kind) unique constraint on
      // a second enqueue — failing an already-ready document. Keeping it last
      // makes the vectorize path idempotent across retries.
      if (enrichmentEnabled) {
        await this.scheduleEnrichJob(job);
      }

      return "completed";
    }, (outcome) => buildDocumentProcessingTraceAttributes(job, {
      stage: "complete",
      outcome,
    }));
  }

  private buildEmbeddingUsage(
    job: DocumentProcessingJobRecord,
    enrichedChunks: Array<{ chunkIndex: number; searchText: string }>,
  ): {
    attemptKey: string;
    chunks: Array<{ chunkIndex: number; contentBytes: number; estimatedTokens: number }>;
  } {
    const chunkDetails = enrichedChunks.map((chunk) => {
      const contentBytes = Buffer.byteLength(chunk.searchText, "utf8");
      return {
        chunkIndex: chunk.chunkIndex,
        contentBytes,
        estimatedTokens: estimateTokensFromBytes(contentBytes),
      };
    });
    const chunkIdentity = createHash("sha256")
      .update(chunkDetails.map((chunk) => `${chunk.chunkIndex}:${chunk.contentBytes}`).join("|"))
      .digest("hex")
      .slice(0, 16);

    return {
      attemptKey: `document:${job.documentId}:${job.documentRevision}:${job.id}:chunks:${chunkIdentity}`,
      chunks: chunkDetails,
    };
  }

  /**
   * The enrich path: runs metadata extraction (LLM) for an already-published
   * document revision and patches document + chunk metadata in place. It never
   * re-embeds and never flips the document status — the document is already
   * queryable, so enrichment is strictly additive and failure-tolerant.
   */
  async processEnrichment(job: DocumentProcessingJobRecord): Promise<DocumentProcessingOutcome> {
    return traceActiveSpan(
      "document.processing.enrich",
      buildDocumentProcessingTraceAttributes(job),
      async () => {
        const document = await this.documentRepository.findByIdAndWorkspaceId(job.documentId, job.workspaceId);
        if (!document) {
          return "deleted";
        }
        // A newer vectorization would have enqueued its own enrich job; skip a
        // superseded one instead of clobbering current metadata.
        if (document.revision !== job.documentRevision || document.status !== "ready") {
          return "stale";
        }
        if (!this.documentEnrichmentStage) {
          return "completed";
        }

        const publishedChunks = await this.chunkRepository.listForDocumentRevision({
          documentId: job.documentId,
          workspaceId: job.workspaceId,
        });

        const baseDocumentMetadata = stripStaleEnrichmentMetadata(
          document.metadata ?? {},
          Boolean(document.enrichment),
        );
        const startedAt = Date.now();
        const anchorDate = toIsoDate(document.createdAt);
        const result = await traceActiveSpan(
          "document.processing.enrichment",
          buildDocumentProcessingTraceAttributes(job, { stage: "enrichment" }),
          () => this.documentEnrichmentStage!.enrich({
            document: {
              id: document.id,
              workspaceId: job.workspaceId,
              revision: job.documentRevision,
              title: document.title,
              markdownContent: document.markdownContent,
              metadata: baseDocumentMetadata,
              createdAt: document.createdAt,
            },
            chunks: publishedChunks,
            anchor: {
              source: "document_created_at",
              date: anchorDate,
            },
          }),
          (enrichment) => buildDocumentProcessingTraceAttributes(job, {
            stage: "enrichment",
            enrichmentStatus: enrichment.status,
            enrichmentFactCount: enrichment.factCount,
            enrichmentAppliedChunkCount: enrichment.appliedChunkCount,
          }),
        );

        const updatedDocument = await this.documentRepository.updateMetadataForRevision({
          documentId: document.id,
          workspaceId: job.workspaceId,
          revision: job.documentRevision,
          metadata: result.documentMetadata,
          enrichment: result.provenance as unknown as Record<string, unknown>,
        });
        if (!updatedDocument) {
          return "stale";
        }

        // Patch only chunks whose metadata the stage changed. Updating
        // chunks.metadata recomputes the stored date columns.
        const patches: ChunkMetadataRevisionPatch[] = result.chunks.map((chunk) => ({
          chunkIndex: chunk.chunkIndex,
          metadata: chunk.metadata ?? {},
        }));
        const chunkPatchApplied = await this.chunkRepository.updateMetadataForDocumentRevision({
          documentId: document.id,
          workspaceId: job.workspaceId,
          revision: job.documentRevision,
          patches,
        });
        if (!chunkPatchApplied) {
          return "stale";
        }

        this.logger?.info(
          {
            role: "worker",
            workspaceId: job.workspaceId,
            documentId: document.id,
            revision: job.documentRevision,
            enrichmentStatus: result.status,
            factCount: result.factCount,
            appliedChunkCount: result.appliedChunkCount,
            enrichmentDurationMs: Math.max(0, Date.now() - startedAt),
          },
          "Document enrichment completed",
        );
        await this.auditService.record({
          workspaceId: job.workspaceId,
          eventType: "document.enrichment",
          eventStatus: result.status === "applied" ? "success" : "failure",
          metadata: {
            documentId: document.id,
            revision: job.documentRevision,
            status: result.status,
            factCount: result.factCount,
            appliedChunkCount: result.appliedChunkCount,
          },
        });

        return "completed";
      },
      (outcome) => buildDocumentProcessingTraceAttributes(job, {
        stage: "complete",
        outcome,
      }),
    );
  }

  private async resolveEnrichmentEnabled(
    job: DocumentProcessingJobRecord,
    input: { sourceId: string | null; workspaceId: string; settings: IngestionSettingsRecord },
  ): Promise<boolean> {
    if (!this.documentEnrichmentStage) {
      return false;
    }
    const source = input.sourceId && this.documentSourceRepository
      ? await this.documentSourceRepository.findByIdAndWorkspaceId(input.sourceId, input.workspaceId)
      : null;
    const enablement = resolveDocumentEnrichmentEnablement({
      workspaceDefaultEnabled: input.settings.documentEnrichmentEnabled ?? false,
      sourceOverride: parseDocumentSourceEnrichmentOverride(source?.config.documentEnrichmentOverride),
      jobOverride: parseDocumentEnrichmentOverride(job.options?.documentEnrichmentOverride),
    });
    return enablement.enabled;
  }

  private async scheduleEnrichJob(job: DocumentProcessingJobRecord): Promise<"pending" | "skipped"> {
    if (!this.jobRepository) {
      return "skipped";
    }
    const enrichJob = await this.jobRepository.ensureEnrichJob({
      documentId: job.documentId,
      workspaceId: job.workspaceId,
      documentRevision: job.documentRevision,
      options: job.options ?? null,
    });
    // Dispatch so task-server (Cloud Tasks) deployments, which do not run the
    // continuous DB poll loop, run enrichment right after vectorization instead
    // of waiting for periodic recovery. Dispatch failure is non-fatal: the poll
    // loop / recovery backstop still picks the row up, and it must never fail the
    // already-completed vectorize job.
    try {
      await this.jobDispatcher.dispatch({
        jobId: enrichJob.id,
        documentId: enrichJob.documentId,
        workspaceId: enrichJob.workspaceId,
        revision: enrichJob.documentRevision,
      });
    } catch (error) {
      await this.auditService.record({
        workspaceId: job.workspaceId,
        eventType: "document.dispatch",
        eventStatus: "failure",
        metadata: {
          documentId: job.documentId,
          revision: job.documentRevision,
          jobKind: "enrich",
          reason: error instanceof Error ? error.message : "Failed to dispatch enrich job",
        },
      });
    }
    this.logger?.info(
      {
        role: "worker",
        workspaceId: job.workspaceId,
        documentId: job.documentId,
        revision: job.documentRevision,
        jobKind: "enrich",
      },
      "Scheduled document enrichment job",
    );
    return "pending";
  }
}

const estimateTokensFromBytes = (bytes: number): number => Math.max(1, Math.ceil(bytes / 4));

const toIsoDate = (date: Date): string => date.toISOString().slice(0, 10);
