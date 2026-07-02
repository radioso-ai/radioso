import { createHash, randomUUID } from "node:crypto";

import type { AuditService } from "../../audit/contracts/index.js";
import type { DocumentProcessingJobRecord } from "../../../db/repositories/documentProcessingJobRepository.js";
import {
  deriveChunkSection,
  deriveDocumentSubject,
  normalizeMarkdown,
  renderMetadataSearchText,
  renderSearchText,
  type ChunkingStrategy,
  type ChunkingStrategyId,
  type EmbeddingService,
} from "../../retrieval/public.js";
import type { IngestionSettingsRecord } from "../../settings/contracts/ingestion.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import { traceOperation } from "../../../shared/observability/tracing/operations.js";
import {
  parseDocumentEnrichmentOverride,
  parseDocumentSourceEnrichmentOverride,
  resolveDocumentEnrichmentEnablement,
} from "../domain/enrichment/enrichmentEnablement.js";
import type {
  ChunkRecord,
  ChunkRepositoryPort,
  DocumentRepositoryPort,
} from "./documentIngestionService.js";
import type {
  DocumentEnrichmentStagePort,
  DocumentEnrichmentStageResult,
} from "./documentEnrichmentService.js";
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
): Record<string, unknown> => {
  if (!metadata.enrichment || typeof metadata.enrichment !== "object") {
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
  job: Pick<DocumentProcessingJobRecord, "id" | "workspaceId" | "documentId" | "documentRevision" | "attemptCount" | "status">,
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
    private readonly embeddingService: EmbeddingService,
    private readonly auditService: AuditService,
    private readonly ingestionSettingsService: IngestionSettingsReaderPort,
    private readonly chunkingStrategyRegistry: ChunkingStrategyRegistryPort,
    private readonly documentSourceContentService: DocumentSourceContentServicePort = inlineDocumentSourceContentService,
    private readonly logger?: AppLogger,
    private readonly documentEnrichmentStage?: DocumentEnrichmentStagePort,
    private readonly documentSourceRepository?: Pick<DocumentSourceRepositoryPort, "findByIdAndWorkspaceId">,
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
      const embeddingModel = settings.pendingEmbeddingModel ?? settings.embeddingModel;
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
          embeddingModel,
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
      const baseDocumentMetadata = stripStaleEnrichmentMetadata(documentWithContent.metadata ?? {});
      const chunkRecordsWithoutSearchText = chunks.map((chunk) => ({
        ...chunk,
        metadata: baseDocumentMetadata,
      }));
      const enrichmentResult = await this.runEnrichmentStage({
        job,
        document: documentWithContent,
        settings,
        chunks: chunkRecordsWithoutSearchText,
      });
      const finalDocumentMetadata = enrichmentResult?.documentMetadata ?? baseDocumentMetadata;
      if (!enrichmentResult && finalDocumentMetadata !== (documentWithContent.metadata ?? {})) {
        const updatedDocument = await this.documentRepository.updateMetadataForRevision({
          documentId: documentWithContent.id,
          workspaceId: job.workspaceId,
          revision: job.documentRevision,
          metadata: finalDocumentMetadata,
        });
        if (!updatedDocument) {
          return "stale";
        }
      }
      const finalChunks = enrichmentResult?.chunks ?? chunkRecordsWithoutSearchText;
      const enrichedChunks = finalChunks.map((chunk) => {
        const metadataSearchText = renderMetadataSearchText(chunk.metadata ?? finalDocumentMetadata);
        return {
          ...chunk,
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
      try {
        const embeddingResult = await traceActiveSpan("document.processing.embedding", buildDocumentProcessingTraceAttributes(job, {
          stage: "embedding",
          chunkCount: enrichedChunks.length,
        }), () => this.embeddingService.embedChunksWithUsage(
          enrichedChunks.map((chunk) => chunk.searchText),
          {
            model: embeddingModel,
            usageContext: {
              workspaceId: job.workspaceId,
              requestId: job.id,
              surface: "documents",
              operation: "embedding",
              attemptKey: embeddingUsage.attemptKey,
            },
            documentId: job.documentId,
            documentRevision: job.documentRevision,
            jobId: job.id,
            usageItems: embeddingUsage.chunks,
          },
        ), (result) => buildDocumentProcessingTraceAttributes(job, {
          stage: "embedding",
          chunkCount: result.vectors.length,
        }));
        embeddings = embeddingResult.vectors;
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
        metadata: chunk.metadata ?? finalDocumentMetadata,
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
      }), (result) => buildDocumentProcessingTraceAttributes(job, {
        stage: "storage",
        outcome: result ? "published" : undefined,
        chunkCount: persistedChunks.length,
      }));

      if (!published) {
        const currentDocument = await this.documentRepository.findByIdAndWorkspaceId(job.documentId, job.workspaceId);
        return currentDocument ? "stale" : "deleted";
      }

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
          enrichmentStatus: enrichmentResult?.status ?? "skipped",
        },
      }));
      await this.ingestionSettingsService.promotePendingEmbeddingModelIfReady?.(job.workspaceId);

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

  private async runEnrichmentStage(input: {
    job: DocumentProcessingJobRecord;
    document: {
      id: string;
      workspaceId: string;
      title: string;
      markdownContent: string;
      metadata: Record<string, unknown>;
      sourceId?: string | null;
      createdAt: Date;
    };
    settings: IngestionSettingsRecord;
    chunks: Array<{
      chunkIndex: number;
      content: string;
      startOffset: number;
      endOffset: number;
      metadata: Record<string, unknown>;
    }>;
  }): Promise<DocumentEnrichmentStageResult<typeof input.chunks[number]> | null> {
    const source = input.document.sourceId && this.documentSourceRepository
      ? await this.documentSourceRepository.findByIdAndWorkspaceId(input.document.sourceId, input.document.workspaceId)
      : null;
    const enablement = resolveDocumentEnrichmentEnablement({
      workspaceDefaultEnabled: input.settings.documentEnrichmentEnabled ?? false,
      sourceOverride: parseDocumentSourceEnrichmentOverride(source?.config.documentEnrichmentOverride),
      jobOverride: parseDocumentEnrichmentOverride(input.job.options?.documentEnrichmentOverride),
    });
    if (!enablement.enabled || !this.documentEnrichmentStage) {
      return null;
    }

    const startedAt = Date.now();
    const anchorDate = toIsoDate(input.document.createdAt);
    const result = await traceActiveSpan(
      "document.processing.enrichment",
      buildDocumentProcessingTraceAttributes(input.job, {
        stage: "enrichment",
      }),
      () => this.documentEnrichmentStage!.enrich({
        document: input.document,
        chunks: input.chunks,
        anchor: {
          source: "document_created_at",
          date: anchorDate,
        },
      }),
      (enrichment) => buildDocumentProcessingTraceAttributes(input.job, {
        stage: "enrichment",
        enrichmentStatus: enrichment.status,
        enrichmentFactCount: enrichment.factCount,
        enrichmentAppliedChunkCount: enrichment.appliedChunkCount,
      }),
    );

    const updatedDocument = await this.documentRepository.updateMetadataForRevision({
      documentId: input.document.id,
      workspaceId: input.job.workspaceId,
      revision: input.job.documentRevision,
      metadata: result.documentMetadata,
    });
    if (!updatedDocument) {
      return null;
    }

    this.logger?.info(
      {
        role: "worker",
        workspaceId: input.job.workspaceId,
        documentId: input.document.id,
        revision: input.job.documentRevision,
        enrichmentStatus: result.status,
        factCount: result.factCount,
        appliedChunkCount: result.appliedChunkCount,
        enrichmentDurationMs: Math.max(0, Date.now() - startedAt),
      },
      "Document enrichment completed",
    );
    await this.auditService.record({
      workspaceId: input.job.workspaceId,
      eventType: "document.enrichment",
      eventStatus: result.status === "applied" ? "success" : "failure",
      metadata: {
        documentId: input.document.id,
        revision: input.job.documentRevision,
        status: result.status,
        factCount: result.factCount,
        appliedChunkCount: result.appliedChunkCount,
      },
    });

    return result;
  }
}

const estimateTokensFromBytes = (bytes: number): number => Math.max(1, Math.ceil(bytes / 4));

const toIsoDate = (date: Date): string => date.toISOString().slice(0, 10);
