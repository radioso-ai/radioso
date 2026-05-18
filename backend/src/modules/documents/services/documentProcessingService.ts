import { randomUUID } from "node:crypto";

import type { AuditService } from "../../audit/contracts/index.js";
import {
  NoopUsageEventRecorder,
  type UsageEventRecorder,
} from "../../../shared/domain/usageEventRecorder.js";
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

export interface EmbeddingProviderIdentityPort {
  identifyForModel(model: string): { provider: string; model: string };
}

const defaultEmbeddingProviderIdentity: EmbeddingProviderIdentityPort = {
  identifyForModel(model: string) {
    return { provider: "unknown", model };
  },
};

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
    private readonly usageEventRecorder: UsageEventRecorder = new NoopUsageEventRecorder(),
    private readonly embeddingProviderIdentity: EmbeddingProviderIdentityPort = defaultEmbeddingProviderIdentity,
  ) {}

  async process(job: DocumentProcessingJobRecord): Promise<DocumentProcessingOutcome> {
    const markedProcessing = await this.documentRepository.setStatusIfRevisionMatches({
      documentId: job.documentId,
      workspaceId: job.workspaceId,
      revision: job.documentRevision,
      status: "processing",
      failureReason: null,
    });

    if (!markedProcessing) {
      const document = await this.documentRepository.findByIdAndWorkspaceId(job.documentId, job.workspaceId);
      return document ? "stale" : "deleted";
    }

    const materializedContent = await this.documentSourceContentService.materialize(markedProcessing);
    const documentWithContent =
      materializedContent.sourceContent !== markedProcessing.sourceContent ||
      materializedContent.markdownContent !== markedProcessing.markdownContent
        ? await this.documentRepository.updateDerivedContentForRevision({
            documentId: markedProcessing.id,
            workspaceId: job.workspaceId,
            revision: job.documentRevision,
            sourceContent: materializedContent.sourceContent,
            markdownContent: materializedContent.markdownContent,
          })
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
    const chunks = await chunkingStrategy.chunk({
      title: documentWithContent.title,
      content: documentWithContent.markdownContent,
      config: {
        fixedWindowChunkSize: settings.fixedWindowChunkSize,
        fixedWindowChunkOverlap: settings.fixedWindowChunkOverlap,
        structuredMinChunkSize: settings.structuredMinChunkSize,
        structuredMaxChunkSize: settings.structuredMaxChunkSize,
        embeddingModel,
      },
    });
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
    const embeddingStartedAt = Date.now();
    const embeddings = await this.embeddingService.embedChunks(
      enrichedChunks.map((chunk) => chunk.searchText),
      { model: embeddingModel },
    );
    const storageEmbeddingDurationMs = Math.max(0, Date.now() - embeddingStartedAt);
    await this.recordEmbeddingUsage(job, enrichedChunks, embeddingModel).catch((error: unknown) => {
      this.logger?.warn(
        {
          role: "worker",
          workspaceId: job.workspaceId,
          documentId: job.documentId,
          revision: job.documentRevision,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to record embedding usage event",
      );
    });
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

    const published = await this.chunkRepository.publishForDocumentRevision({
      documentId: documentWithContent.id,
      workspaceId: job.workspaceId,
      revision: job.documentRevision,
      chunks: persistedChunks,
    });

    if (!published) {
      const currentDocument = await this.documentRepository.findByIdAndWorkspaceId(job.documentId, job.workspaceId);
      return currentDocument ? "stale" : "deleted";
    }

    await this.auditService.record({
        workspaceId: job.workspaceId,
        eventType: "document.process",
        eventStatus: "success",
        metadata: {
        documentId: documentWithContent.id,
        revision: job.documentRevision,
      },
    });
    await this.ingestionSettingsService.promotePendingEmbeddingModelIfReady?.(job.workspaceId);

    return "completed";
  }

  private async recordEmbeddingUsage(
    job: DocumentProcessingJobRecord,
    enrichedChunks: Array<{ chunkIndex: number; searchText: string }>,
    embeddingModel: string,
  ): Promise<void> {
    if (enrichedChunks.length === 0) {
      return;
    }
    const identity = this.embeddingProviderIdentity.identifyForModel(embeddingModel);
    let totalInputBytes = 0;
    const chunkDetails = enrichedChunks.map((chunk) => {
      const contentBytes = Buffer.byteLength(chunk.searchText, "utf8");
      totalInputBytes += contentBytes;
      return {
        chunkIndex: chunk.chunkIndex,
        contentBytes,
        estimatedTokens: estimateTokensFromBytes(contentBytes),
      };
    });
    const estimatedTotalTokens = chunkDetails.reduce(
      (acc, chunk) => acc + (chunk.estimatedTokens ?? 0),
      0,
    );

    await this.usageEventRecorder.recordEmbedding({
      idempotencyKey: `embed:${job.workspaceId}:${job.documentId}:${job.documentRevision}:batch:${identity.provider}:${identity.model}`,
      workspaceId: job.workspaceId,
      documentId: job.documentId,
      documentRevision: job.documentRevision,
      jobId: job.id,
      provider: identity.provider,
      model: identity.model,
      inputTokens: estimatedTotalTokens,
      inputBytes: totalInputBytes,
      vectorCount: enrichedChunks.length,
      status: "succeeded",
      usageQuality: "estimated",
      chunks: chunkDetails,
    });
  }
}

const estimateTokensFromBytes = (bytes: number): number => Math.max(1, Math.ceil(bytes / 4));
