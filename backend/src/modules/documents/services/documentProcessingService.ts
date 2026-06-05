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
import { safeSpanAttributes, setActiveSpanAttributes, startActiveSpan } from "../../../shared/observability/tracing/index.js";
import type {
  ChunkRecord,
  ChunkRepositoryPort,
  DocumentRepositoryPort,
} from "./documentIngestionService.js";
import type { MaterializedDocumentContent } from "./documentSourceContentService.js";

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

const traceActiveSpan = async <T>(
  name: string,
  attributes: TraceAttributes,
  run: () => Promise<T> | T,
  resultAttributes?: (result: T) => TraceAttributes,
): Promise<T> => {
  return startActiveSpan(name, attributes, async (span) => {
    const result = await run();
    const finalAttributes = resultAttributes?.(result);
    if (finalAttributes) {
      const safeFinalAttributes = safeSpanAttributes(finalAttributes);
      const spanSink = span as { setAttributes?: (attributes: typeof safeFinalAttributes) => unknown } | undefined;
      if (spanSink?.setAttributes) {
        spanSink.setAttributes(safeFinalAttributes);
      } else {
        setActiveSpanAttributes(safeFinalAttributes);
      }
    }
    return result;
  }) as Promise<T>;
};

const boundedTraceCount = (value: number | undefined): number =>
  Math.min(1_000, Math.max(0, value ?? 0));

const compactTraceAttributes = (attributes: TraceAttributes): TraceAttributes =>
  Object.fromEntries(
    Object.entries(attributes).filter(([, value]) => value !== undefined && value !== null),
  ) as TraceAttributes;

export const buildDocumentProcessingTraceAttributes = (
  job: Pick<DocumentProcessingJobRecord, "id" | "workspaceId" | "documentId" | "documentRevision" | "attemptCount" | "status">,
  input: {
    stage?: "claim" | "materialize" | "chunking" | "embedding" | "storage" | "audit" | "complete";
    outcome?: DocumentProcessingOutcome | "completed" | "published";
    chunkCount?: number;
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
      const metadataSearchText = renderMetadataSearchText(documentWithContent.metadata ?? {});
      const enrichedChunks = chunks.map((chunk) => ({
        ...chunk,
        searchText: renderSearchText({
          title: documentWithContent.title,
          subjectLabel: documentSubject,
          sectionPath: deriveChunkSection(chunk.content),
          attributeText: metadataSearchText,
          content: chunk.content,
        }),
      }));
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
        metadata: documentWithContent.metadata ?? {},
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
}

const estimateTokensFromBytes = (bytes: number): number => Math.max(1, Math.ceil(bytes / 4));
