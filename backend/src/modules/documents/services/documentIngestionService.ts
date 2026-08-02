import { createHash } from "node:crypto";

import type { EmbeddingSpaceRef } from "../../embeddingProfiles/contracts/embeddingConsumers.js";
import type { AuditService } from "../../audit/contracts/index.js";
import type {
  DocumentProcessingJobRecord,
  DocumentProcessingJobRepositoryPort,
  DocumentProcessingQueueSnapshot,
  DocumentProcessingJobOptions,
} from "../../../db/repositories/documentProcessingJobRepository.js";
import type { DocumentEnrichmentProvenance } from "../domain/enrichment/documentEnrichmentContract.js";
import { normalizeMarkdown, renderMetadataSearchText } from "../../retrieval/public.js";
import { badRequest, conflict, notFound } from "../../../shared/domain/errors.js";
import {
  toDocumentSourceSummary,
  type DocumentSourceRecord as DocumentOriginRecord,
  type DocumentSourceRepositoryPort,
  type DocumentSourceSummary,
} from "../../../db/repositories/documentSourceRepository.js";
import {
  NoopProductAnalyticsService,
  type ProductAnalyticsPort,
} from "../../../shared/analytics/productAnalyticsService.js";
import {
  NoopUsageLimitPolicy,
  type UsageLimitPolicy,
  type UsageLimitReservation,
} from "../../../shared/domain/usageLimitPolicy.js";
import { NoopDocumentJobDispatcher, type DocumentJobDispatcherPort } from "./documentJobDispatcher.js";
import { sanitizeInlineDocumentContent } from "./inlineDocumentContentSanitizer.js";
import { MANUALLY_ADDED_DOCUMENTS_SOURCE_ID } from "../domain/sourceConstants.js";
import type { DocumentCorpusChangeObserverPort } from "../contracts/corpusChangeObserver.js";

export type DocumentSourceKind = "inline_text" | "uploaded_file";
export type DocumentSourceResolverInput =
  | { id: string }
  | {
      kind: "website";
      url: string;
      config?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
    }
  | {
      kind: "connector";
      externalId: string;
      name: string;
      config?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
    };

export interface DocumentSourceRecord {
  sourceKind: DocumentSourceKind;
  sourceFilename?: string | null;
  sourceMimeType?: string | null;
  sourceStorageBucket?: string | null;
  sourceStorageObject?: string | null;
  sourceStorageGeneration?: string | null;
  sourceSizeBytes?: number | null;
  // Inline documents meter normalized markdown bytes. Uploaded files meter the
  // stored object bytes because the original object is the durable storage unit.
  contentSizeBytes?: number | null;
  contentHash?: string | null;
}

export interface DocumentSourceInput {
  sourceKind?: DocumentSourceKind;
  sourceFilename?: string | null;
  sourceMimeType?: string | null;
  sourceStorageBucket?: string | null;
  sourceStorageObject?: string | null;
  sourceStorageGeneration?: string | null;
  sourceSizeBytes?: number | null;
  contentSizeBytes?: number | null;
  contentHash?: string | null;
}

export interface DocumentRecord extends DocumentSourceRecord {
  id: string;
  workspaceId: string;
  title: string;
  sourceContent: string;
  markdownContent: string;
  sourceId?: string | null;
  source?: DocumentSourceSummary | null;
  externalDocumentId?: string | null;
  status: string;
  revision: number;
  failureReason?: string | null;
  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, unknown>;
  enrichment?: DocumentEnrichmentProvenance | null;
  // Retrieval eligibility, orthogonal to processing `status`. Disabled or
  // expired documents stay 'ready' and visible; they are only kept out of
  // retrieval. See DocumentRetrievalEligibilityInput and the retrieval filter
  // in modules/retrieval/infra/documentRetrievalEligibility.ts.
  retrievalEnabled: boolean;
  retrievalExpiresAt: Date | null;
}

export interface DocumentCreateInput extends DocumentSourceInput {
  workspaceId: string;
  title: string;
  sourceContent: string;
  markdownContent: string;
  sourceId?: string | null;
  source?: DocumentSourceSummary | null;
  metadata?: Record<string, unknown>;
  externalDocumentId?: string | null;
}

export interface DocumentUpdateInput extends DocumentSourceInput {
  documentId: string;
  workspaceId: string;
  title: string;
  sourceContent: string;
  markdownContent: string;
  status: string;
  sourceId?: string | null;
  source?: DocumentSourceSummary | null;
  metadata?: Record<string, unknown>;
  externalDocumentId?: string | null;
}

export interface DocumentQueueUpdateInput extends DocumentSourceInput {
  documentId: string;
  workspaceId: string;
  title: string;
  sourceContent: string;
  markdownContent: string;
  sourceId?: string | null;
  source?: DocumentSourceSummary | null;
  metadata?: Record<string, unknown>;
  externalDocumentId?: string | null;
}

export interface DocumentDerivedContentUpdateInput {
  documentId: string;
  workspaceId: string;
  revision: number;
  sourceContent: string;
  markdownContent: string;
}

// Absolute retrieval-eligibility state written to a document without re-queuing
// or re-processing it. The service resolves partial API input into these
// explicit values (see DocumentIngestionService.updateRetrievalEligibility).
export interface DocumentRetrievalEligibilityInput {
  documentId: string;
  workspaceId: string;
  retrievalEnabled: boolean;
  retrievalExpiresAt: Date | null;
}

export interface ChunkRecord {
  id: string;
  documentId: string;
  workspaceId: string;
  chunkIndex: number;
  content: string;
  searchText?: string | null;
  embedding: number[];
  embeddingModel?: string | null;
  startOffset: number;
  endOffset: number;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

export interface DocumentEnrichmentMetadataUpdateInput {
  documentId: string;
  workspaceId: string;
  revision: number;
  metadata: Record<string, unknown>;
  // Extraction provenance lives in its own column so document metadata stays a
  // flat user-owned contract; null clears provenance from a prior run.
  enrichment?: Record<string, unknown> | null;
}

export interface DocumentRepositoryPort {
  createAndQueue(input: DocumentCreateInput, options?: DocumentProcessingJobOptions | null): Promise<DocumentRecord>;
  create(input: DocumentCreateInput & { status: string }): Promise<DocumentRecord>;
  summarizeWorkspace(workspaceId: string): Promise<DocumentWorkspaceSummaryRecord>;
  setStatus(input: {
    documentId: string;
    workspaceId: string;
    status: string;
    failureReason?: string | null;
  }): Promise<DocumentRecord>;
  setStatusIfRevisionMatches(input: {
    documentId: string;
    workspaceId: string;
    revision: number;
    status: string;
    failureReason?: string | null;
  }): Promise<DocumentRecord | null>;
  findByIdAndWorkspaceId(documentId: string, workspaceId: string): Promise<DocumentRecord | null>;
  listByWorkspaceId(workspaceId: string): Promise<DocumentRecord[]>;
  findByExternalDocumentId(
    workspaceId: string,
    externalDocumentId: string,
  ): Promise<DocumentRecord | null>;
  findBySourceAndExternalDocumentId(
    workspaceId: string,
    sourceId: string,
    externalDocumentId: string,
  ): Promise<DocumentRecord | null>;
  listSummariesByIdsAndWorkspaceId(workspaceId: string, documentIds: string[]): Promise<DocumentSummaryRecord[]>;
  listSummaryPageByWorkspaceId(
    workspaceId: string,
    input: { limit: number; offset?: number; cursor?: string },
  ): Promise<{ documents: DocumentSummaryRecord[]; total: number; nextCursor: string | null; hasMore: boolean }>;
  update(input: DocumentUpdateInput): Promise<DocumentRecord>;
  updateAndQueue(input: DocumentQueueUpdateInput): Promise<DocumentRecord>;
  updateDerivedContentForRevision(input: DocumentDerivedContentUpdateInput): Promise<DocumentRecord | null>;
  updateMetadataForRevision(input: DocumentEnrichmentMetadataUpdateInput): Promise<DocumentRecord | null>;
  // Targeted retrieval-eligibility write that does not touch content, status, or
  // revision and does not re-queue processing. Returns null when no row matches.
  setRetrievalEligibility(input: DocumentRetrievalEligibilityInput): Promise<DocumentRecord | null>;
  requeue(documentId: string, workspaceId: string): Promise<DocumentRecord>;
  requeueAndQueue(documentId: string, workspaceId: string, options?: DocumentProcessingJobOptions | null): Promise<DocumentRecord>;
  requeueAllEligibleAndQueue(workspaceId: string, options?: DocumentProcessingJobOptions | null): Promise<{
    queuedDocumentCount: number;
    skippedDocumentCount: number;
    queuedDocuments: Array<{ documentId: string; revision: number }>;
  }>;
  requeueSourceEligibleAndQueue(input: {
    workspaceId: string;
    sourceId: string;
    options?: DocumentProcessingJobOptions | null;
  }): Promise<{
    queuedDocumentCount: number;
    skippedDocumentCount: number;
    queuedDocuments: Array<{ documentId: string; revision: number }>;
  }>;
  deleteByIdAndWorkspaceId(documentId: string, workspaceId: string): Promise<boolean>;
  listSummaryPageBySourceId(
    workspaceId: string,
    sourceId: string | null,
    input: { limit: number; offset?: number; cursor?: string },
  ): Promise<{ documents: DocumentSummaryRecord[]; total: number; nextCursor: string | null; hasMore: boolean }>;
  deleteBySourceIdAndWorkspaceId(sourceId: string, workspaceId: string): Promise<{
    count: number;
    storageRefs: Array<{ bucket: string; objectPath: string; generation: string | null }>;
  }>;
  findActivePageState(input: {
    workspaceId: string;
    sourceId?: string | null;
    externalDocumentId: string;
  }): Promise<{
    documentId: string;
    revision: number;
    contentSizeBytes: number | null;
    contentHash: string | null;
  } | null>;
  deleteMissingPagesBySourceAndExternalIds(input: {
    workspaceId: string;
    sourceId: string;
    keepExternalDocumentIds: string[];
  }): Promise<{ deletedCount: number; deletedContentBytes: number }>;
}

export interface DocumentWorkspaceSummaryRecord {
  documentCount: number;
  readyDocumentCount: number;
  pendingDocumentCount: number;
  sampleDocumentCount: number;
  sampleDocumentSlugs: string[];
}

export interface ChunkSummary {
  id: string;
  chunkIndex: number;
  contentPreview: string;
  contentLength: number;
  startOffset: number;
  endOffset: number;
  dateFrom: string | null;
  dateTo: string | null;
}

export interface ChunkDetail {
  id: string;
  documentId: string;
  workspaceId: string;
  chunkIndex: number;
  content: string;
  searchText: string | null;
  startOffset: number;
  endOffset: number;
  metadata: Record<string, unknown>;
  dateFrom?: string | null;
  dateTo?: string | null;
  createdAt: Date;
  embeddingDimensions: number | null;
}

export interface PublishedChunkRecord {
  chunkIndex: number;
  content: string;
  startOffset: number;
  endOffset: number;
  metadata: Record<string, unknown>;
}

export interface ChunkMetadataRevisionPatch {
  chunkIndex: number;
  metadata: Record<string, unknown>;
}

export interface ChunkRepositoryPort {
  replaceForDocument(documentId: string, chunks: ChunkRecord[]): Promise<void>;
  publishForDocumentRevision(input: {
    documentId: string;
    workspaceId: string;
    revision: number;
    chunks: ChunkRecord[];
    embeddingSpace: EmbeddingSpaceRef;
    canonicalVersion: string;
  }): Promise<boolean>;
  // Reads the published chunks for a document so a later, out-of-band stage
  // (async enrichment) can re-derive per-chunk metadata without re-chunking.
  listForDocumentRevision(input: { documentId: string; workspaceId: string }): Promise<PublishedChunkRecord[]>;
  // Patches per-chunk metadata in place, guarded by revision so a superseded
  // enrich job cannot clobber a newer vectorization. Returns false when the
  // document revision no longer matches (skip, do not error). The stored
  // date_from/date_to columns recompute from metadata automatically —
  // no re-embed is performed.
  updateMetadataForDocumentRevision(input: {
    documentId: string;
    workspaceId: string;
    revision: number;
    patches: ChunkMetadataRevisionPatch[];
  }): Promise<boolean>;
  listSummariesForDocument(input: { documentId: string; workspaceId: string }): Promise<ChunkSummary[]>;
  findByIdForDocument(input: {
    chunkId: string;
    documentId: string;
    workspaceId: string;
  }): Promise<ChunkDetail | null>;
}

export interface DocumentSummary {
  id: string;
  title: string;
  status: string;
  ragStatus: "processed" | "pending";
  failureReason?: string | null;
  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, unknown>;
  sourceId?: string | null;
  source?: DocumentSourceSummary | null;
  externalDocumentId?: string | null;
  sourceKind: DocumentSourceKind;
  sourceFilename?: string | null;
  sourceMimeType?: string | null;
  contentSize?: number | null;
  contentSizeBytes?: number | null;
  enrichment?: DocumentEnrichmentProvenance | null;
  retrievalEnabled: boolean;
  retrievalExpiresAt: Date | null;
}

export interface DocumentListPage {
  documents: DocumentSummary[];
  total: number;
  nextCursor: string | null;
  hasMore: boolean;
}

export interface EmbeddingCoverageReconciliationPort {
  reconcileWorkspace(
    workspaceId: string,
  ): Promise<{ enqueued: number; skipped: number }>;
}

export interface DocumentDetails extends DocumentSummary {
  content: string;
}

export interface DocumentSummaryRecord extends DocumentSourceRecord {
  id: string;
  workspaceId: string;
  title: string;
  status: string;
  failureReason?: string | null;
  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, unknown>;
  sourceId?: string | null;
  source?: DocumentSourceSummary | null;
  externalDocumentId?: string | null;
  contentSize?: number | null;
  contentSizeBytes?: number | null;
  enrichment?: DocumentEnrichmentProvenance | null;
  retrievalEnabled: boolean;
  retrievalExpiresAt: Date | null;
}

export class DocumentIngestionService {
  constructor(
    private readonly documentRepository: DocumentRepositoryPort,
    private readonly auditService: AuditService,
    private readonly getQueueSnapshot?: () => Promise<DocumentProcessingQueueSnapshot>,
    private readonly jobRepository?: Pick<DocumentProcessingJobRepositoryPort, "findByDocumentRevision">,
    private readonly jobDispatcher: DocumentJobDispatcherPort = new NoopDocumentJobDispatcher(),
    private readonly productAnalyticsService: ProductAnalyticsPort = new NoopProductAnalyticsService(),
    private readonly usageLimitPolicy: UsageLimitPolicy = new NoopUsageLimitPolicy(),
    private readonly documentSourceRepository?: DocumentSourceRepositoryPort,
    private readonly embeddingCoverage?: EmbeddingCoverageReconciliationPort,
    private readonly corpusChanges?: DocumentCorpusChangeObserverPort,
  ) {}

  async ingest(input: {
    workspaceId: string;
    accountId?: string | null;
    title: string;
    content: string;
    metadata?: Record<string, unknown>;
    externalDocumentId?: string | null;
    source?: DocumentSourceResolverInput;
    documentEnrichmentOverride?: DocumentProcessingJobOptions["documentEnrichmentOverride"];
  }): Promise<{ documentId: string; status: string }> {
    const sanitizedContent = sanitizeInlineDocumentContent({
      title: input.title,
      sourceContent: input.content,
      metadata: input.metadata,
    });
    const indexedContent = describeIndexedContent(sanitizedContent.markdownContent, input.metadata);
    const resolvedSource = await this.resolveSourceForInput(input.workspaceId, input.source);
    const externalDocumentId = input.externalDocumentId ?? null;

    const existingPage = externalDocumentId
      ? await this.documentRepository.findActivePageState({
          workspaceId: input.workspaceId,
          sourceId: resolvedSource.sourceId ?? null,
          externalDocumentId,
        })
      : null;

    if (existingPage && existingPage.contentHash && existingPage.contentHash === indexedContent.contentHash) {
      return {
        documentId: existingPage.documentId,
        status: "ready",
      };
    }

    const previousBytes = existingPage?.contentSizeBytes ?? 0;
    // Delta reservation is intentionally conservative for concurrent recrawls:
    // the EE quota lock serializes the account cap check, but two workers can
    // still observe the same previous page size before one commits.
    const deltaBytes = Math.max(0, indexedContent.contentSizeBytes - previousBytes);
    let document:
      | {
          id: string;
          sourceId?: string | null;
          externalDocumentId?: string | null;
          revision: number;
          status: string;
        }
      | undefined;
    const usageReservation = await this.usageLimitPolicy.reserveDocument({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sourceKind: "inline_text",
      externalDocumentId: input.externalDocumentId,
    });
    const storageReservation = await this.usageLimitPolicy.reserveIndexedStorage({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      contentSizeBytes: deltaBytes,
      sourceKind: "inline_text",
      externalDocumentId: input.externalDocumentId,
    }).catch(async (error) => {
      await usageReservation.release();
      throw error;
    });
    const monthlyReservation = await this.usageLimitPolicy.reserveMonthlyIndexedContent({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      contentSizeBytes: indexedContent.contentSizeBytes,
      sourceKind: "inline_text",
      externalDocumentId: input.externalDocumentId,
    }).catch(async (error) => {
      await usageReservation.release();
      await storageReservation.release();
      throw error;
    });

    try {
      document = await this.documentRepository.createAndQueue({
        workspaceId: input.workspaceId,
        title: input.title,
        sourceContent: sanitizedContent.sourceContent,
        markdownContent: indexedContent.markdownContent,
        ...resolvedSource,
        metadata: input.metadata,
        externalDocumentId: input.externalDocumentId,
        sourceKind: "inline_text",
        sourceFilename: null,
        sourceMimeType: "text/plain",
        sourceStorageBucket: null,
        sourceStorageObject: null,
        sourceStorageGeneration: null,
        sourceSizeBytes: null,
        contentSizeBytes: indexedContent.contentSizeBytes,
        contentHash: indexedContent.contentHash,
      }, buildDocumentProcessingOptions(input));

    } catch (error) {
      await usageReservation.release();
      await storageReservation.release();
      await monthlyReservation.release();
      await this.auditService.record({
        workspaceId: input.workspaceId,
        eventType: "document.ingest",
        eventStatus: "failure",
        metadata: {
          externalDocumentId: input.externalDocumentId ?? null,
          reason: error instanceof Error ? error.message : "Failed to queue document processing",
        },
      });
      try {
        await this.productAnalyticsService.track({
          eventName: "document.ingest_failed",
          workspaceId: input.workspaceId,
          subjectType: "document",
          properties: {
            title: input.title,
            reason: error instanceof Error ? error.message : "Failed to queue document processing",
          },
          source: "backend",
        });
      } catch {
        // Analytics fan-out must not change failure behavior.
      }
      throw error;
    }

    await this.auditService.record({
      workspaceId: input.workspaceId,
      eventType: "document.ingest",
      eventStatus: "success",
      metadata: {
        documentId: document.id,
        sourceId: document.sourceId ?? null,
        externalDocumentId: document.externalDocumentId ?? null,
        revision: document.revision,
        status: document.status,
        ...(await this.queueSnapshotMetadata()),
      },
    });
    try {
      await this.productAnalyticsService.track({
        eventName: "document.ingest_queued",
        workspaceId: input.workspaceId,
        subjectType: "document",
        subjectId: document.id,
        properties: {
          revision: document.revision,
          status: document.status,
        },
        source: "backend",
      });
    } catch {
      // Analytics fan-out must not change successful ingest behavior.
    }
    await this.dispatchQueuedDocumentJob({
      documentId: document.id,
      workspaceId: input.workspaceId,
      revision: document.revision,
    });
    await usageReservation.commit();
    await storageReservation.commit();
    await monthlyReservation.commit();

    return {
      documentId: document.id,
      status: document.status,
    };
  }

  async update(input: {
    accountId?: string | null;
    workspaceId: string;
    documentId: string;
    title: string;
    content: string;
    metadata?: Record<string, unknown>;
    externalDocumentId?: string | null;
    source?: DocumentSourceResolverInput;
  }): Promise<{ documentId: string; status: string }> {
    const sanitizedContent = sanitizeInlineDocumentContent({
      title: input.title,
      sourceContent: input.content,
      metadata: input.metadata,
    });
    const indexedContent = describeIndexedContent(sanitizedContent.markdownContent, input.metadata);
    let document:
      | {
          id: string;
          sourceId?: string | null;
          externalDocumentId?: string | null;
          revision: number;
          status: string;
        }
      | undefined;
    let storageReservation: UsageLimitReservation | undefined;
    let monthlyReservation: UsageLimitReservation | undefined;

    try {
      const existing = await this.documentRepository.findByIdAndWorkspaceId(input.documentId, input.workspaceId);
      if (!existing) {
        throw notFound("Document not found");
      }
      if (existing.sourceKind === "uploaded_file") {
        throw conflict("Imported documents cannot be updated through the inline document API");
      }
      if (
        input.source !== undefined &&
        (existing.sourceId ?? null) !== MANUALLY_ADDED_DOCUMENTS_SOURCE_ID
      ) {
        throw conflict("Source can only be changed for manually-added documents");
      }
      if (
        existing.externalDocumentId &&
        input.externalDocumentId !== undefined &&
        input.externalDocumentId !== existing.externalDocumentId
      ) {
        throw conflict("externalDocumentId cannot be changed once set");
      }

      const previousBytes = existing.contentSizeBytes ?? 0;
      const deltaBytes = Math.max(0, indexedContent.contentSizeBytes - previousBytes);
      const monthlyIndexedBytes = existing.contentHash && existing.contentHash === indexedContent.contentHash
        ? 0
        : indexedContent.contentSizeBytes;
      const reservationExternalDocumentId = input.externalDocumentId ?? existing.externalDocumentId;
      storageReservation = await this.usageLimitPolicy.reserveIndexedStorage({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        contentSizeBytes: deltaBytes,
        sourceKind: "inline_text",
        externalDocumentId: reservationExternalDocumentId,
      });
      monthlyReservation = await this.usageLimitPolicy.reserveMonthlyIndexedContent({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        contentSizeBytes: monthlyIndexedBytes,
        sourceKind: "inline_text",
        externalDocumentId: reservationExternalDocumentId,
      });

      document = await this.documentRepository.updateAndQueue({
        documentId: input.documentId,
        workspaceId: input.workspaceId,
        title: input.title,
        sourceContent: sanitizedContent.sourceContent,
        markdownContent: indexedContent.markdownContent,
        ...(await this.resolveSourceForInput(input.workspaceId, input.source)),
        metadata: input.metadata,
        externalDocumentId: input.externalDocumentId,
        sourceKind: "inline_text",
        sourceFilename: null,
        sourceMimeType: "text/plain",
        sourceStorageBucket: null,
        sourceStorageObject: null,
        sourceStorageGeneration: null,
        sourceSizeBytes: null,
        contentSizeBytes: indexedContent.contentSizeBytes,
        contentHash: indexedContent.contentHash,
      });

    } catch (error) {
      await monthlyReservation?.release();
      await storageReservation?.release();
      await this.auditService.record({
        workspaceId: input.workspaceId,
        eventType: "document.update",
        eventStatus: "failure",
        metadata: {
          documentId: input.documentId,
          externalDocumentId: input.externalDocumentId ?? null,
          reason: error instanceof Error ? error.message : "Failed to queue document processing",
        },
      });
      throw error;
    }

    await this.auditService.record({
      workspaceId: input.workspaceId,
      eventType: "document.update",
      eventStatus: "success",
      metadata: {
        documentId: document.id,
        sourceId: document.sourceId ?? null,
        externalDocumentId: document.externalDocumentId ?? null,
        revision: document.revision,
        status: document.status,
        ...(await this.queueSnapshotMetadata()),
      },
    });
    await this.dispatchQueuedDocumentJob({
      documentId: document.id,
      workspaceId: input.workspaceId,
      revision: document.revision,
    });
    await storageReservation?.commit();
    await monthlyReservation?.commit();

    return {
      documentId: document.id,
      status: document.status,
    };
  }

  // Toggle a document's retrieval eligibility without re-processing it. Partial:
  // an absent field is left unchanged. Re-enabling a document
  // (`retrievalEnabled: true`) also clears an already-elapsed expiry, so the
  // "auto-exclude after a date, unless the user re-enables it" contract holds —
  // a passed expiry cannot immediately re-exclude a document the user just
  // switched back on.
  async updateRetrievalEligibility(input: {
    workspaceId: string;
    documentId: string;
    retrievalEnabled?: boolean;
    retrievalExpiresAt?: Date | null;
  }): Promise<DocumentDetails> {
    const existing = await this.documentRepository.findByIdAndWorkspaceId(input.documentId, input.workspaceId);
    if (!existing) {
      throw notFound("Document not found");
    }

    const nextEnabled = input.retrievalEnabled ?? existing.retrievalEnabled;
    let nextExpiresAt =
      input.retrievalExpiresAt !== undefined ? input.retrievalExpiresAt : existing.retrievalExpiresAt;
    if (input.retrievalEnabled === true && nextExpiresAt !== null && nextExpiresAt.getTime() <= Date.now()) {
      nextExpiresAt = null;
    }

    let updated: DocumentRecord | null;
    try {
      updated = await this.documentRepository.setRetrievalEligibility({
        documentId: input.documentId,
        workspaceId: input.workspaceId,
        retrievalEnabled: nextEnabled,
        retrievalExpiresAt: nextExpiresAt,
      });
    } catch (error) {
      await this.auditService.record({
        workspaceId: input.workspaceId,
        eventType: "document.retrieval.update",
        eventStatus: "failure",
        metadata: {
          documentId: input.documentId,
          reason: error instanceof Error ? error.message : "Failed to update retrieval eligibility",
        },
      });
      throw error;
    }

    if (!updated) {
      throw notFound("Document not found");
    }

    await this.embeddingCoverage?.reconcileWorkspace(input.workspaceId);

    await this.auditService.record({
      workspaceId: input.workspaceId,
      eventType: "document.retrieval.update",
      eventStatus: "success",
      metadata: {
        documentId: updated.id,
        retrievalEnabled: updated.retrievalEnabled,
        retrievalExpiresAt: updated.retrievalExpiresAt ? updated.retrievalExpiresAt.toISOString() : null,
      },
    });

    return this.toDetails(updated);
  }

  async reprocess(input: {
    workspaceId: string;
    documentId: string;
    documentEnrichmentOverride?: DocumentProcessingJobOptions["documentEnrichmentOverride"];
  }): Promise<{ documentId: string; status: string }> {
    await this.getDocument(input.workspaceId, input.documentId);

    let document:
      | {
          id: string;
          revision: number;
          status: string;
        }
      | undefined;

    try {
      document = await this.documentRepository.requeueAndQueue(
        input.documentId,
        input.workspaceId,
        buildDocumentProcessingOptions(input),
      );
    } catch (error) {
      await this.auditService.record({
        workspaceId: input.workspaceId,
        eventType: "document.reprocess",
        eventStatus: "failure",
        metadata: {
          documentId: input.documentId,
          reason: error instanceof Error ? error.message : "Failed to queue document processing",
        },
      });
      throw error;
    }

    await this.auditService.record({
      workspaceId: input.workspaceId,
      eventType: "document.reprocess",
      eventStatus: "success",
      metadata: {
        documentId: document.id,
        revision: document.revision,
        status: document.status,
        documentEnrichmentOverride: input.documentEnrichmentOverride ?? null,
        ...(await this.queueSnapshotMetadata()),
      },
    });
    await this.dispatchQueuedDocumentJob({
      documentId: document.id,
      workspaceId: input.workspaceId,
      revision: document.revision,
    });

    return {
      documentId: document.id,
      status: document.status,
    };
  }

  async getDocument(workspaceId: string, documentId: string): Promise<DocumentDetails> {
    const document = await this.documentRepository.findByIdAndWorkspaceId(documentId, workspaceId);
    if (!document) {
      throw notFound("Document not found");
    }

    return this.toDetails(document);
  }

  async listForWorkspace(
    workspaceId: string,
    input: { limit: number; offset?: number; cursor?: string },
  ): Promise<DocumentListPage> {
    const { documents, total, nextCursor, hasMore } = await this.documentRepository.listSummaryPageByWorkspaceId(
      workspaceId,
      input,
    );
    return {
      documents: documents.map((document) => this.toSummary(document)),
      total,
      nextCursor,
      hasMore,
    };
  }

  async listForSource(
    workspaceId: string,
    sourceId: string | null,
    input: { limit: number; offset?: number; cursor?: string },
  ): Promise<DocumentListPage> {
    const { documents, total, nextCursor, hasMore } = await this.documentRepository.listSummaryPageBySourceId(
      workspaceId,
      sourceId,
      input,
    );
    return {
      documents: documents.map((document) => this.toSummary(document)),
      total,
      nextCursor,
      hasMore,
    };
  }

  async deleteSourceWithDocuments(input: {
    workspaceId: string;
    sourceId: string;
    documentStorage?: { delete(input: { bucket: string; objectPath: string; generation: string | null }): Promise<void> };
  }): Promise<{ deletedDocumentCount: number }> {
    const { count: deletedDocumentCount, storageRefs } = await this.documentRepository.deleteBySourceIdAndWorkspaceId(
      input.sourceId,
      input.workspaceId,
    );
    if (deletedDocumentCount > 0) {
      await this.corpusChanges?.onCorpusChanged({
        workspaceId: input.workspaceId,
        change: "deleted",
      });
    }
    if (input.documentStorage && storageRefs.length > 0) {
      await Promise.allSettled(
        storageRefs.map((ref) => input.documentStorage!.delete(ref)),
      );
    }
    await this.documentSourceRepository?.deleteByIdAndWorkspaceId(input.sourceId, input.workspaceId);
    await this.auditService.record({
      workspaceId: input.workspaceId,
      eventType: "document.source.delete",
      eventStatus: "success",
      metadata: {
        sourceId: input.sourceId,
        deletedDocumentCount,
      },
    });
    return { deletedDocumentCount };
  }

  private toSummary(document: DocumentSummaryRecord): DocumentSummary {
    return {
      id: document.id,
      title: document.title,
      status: document.status,
      ragStatus: document.status === "ready" ? "processed" : "pending",
      failureReason: document.failureReason ?? null,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
      metadata: document.metadata,
      sourceId: document.sourceId ?? null,
      source: document.source ?? null,
      externalDocumentId: document.externalDocumentId ?? null,
      sourceKind: document.sourceKind,
      sourceFilename: document.sourceFilename ?? null,
      sourceMimeType: document.sourceMimeType ?? null,
      contentSize: document.contentSize ?? document.contentSizeBytes ?? null,
      contentSizeBytes: document.contentSizeBytes ?? null,
      enrichment: document.enrichment ?? null,
      retrievalEnabled: document.retrievalEnabled,
      retrievalExpiresAt: document.retrievalExpiresAt,
    };
  }

  private toDetails(document: DocumentRecord): DocumentDetails {
    return {
      ...this.toSummary(document),
      content: document.sourceContent,
    };
  }

  async resolveSource(input: {
    workspaceId: string;
    source: DocumentSourceResolverInput;
  }): Promise<DocumentOriginRecord> {
    return this.requireDocumentSource(input.workspaceId, input.source);
  }

  async updateSourceSyncState(input: {
    workspaceId: string;
    sourceId: string;
    status: string;
    syncedAt?: Date | null;
  }): Promise<void> {
    await this.documentSourceRepository?.updateSyncState(input);
  }

  async reapMissingPages(input: {
    workspaceId: string;
    sourceId: string;
    keepExternalDocumentIds: string[];
  }): Promise<{ deletedCount: number; deletedContentBytes: number }> {
    // Persist before reaping: a notification failure leaves the source rows intact,
    // while a later delete failure leaves only a harmless, retryable false positive.
    await this.corpusChanges?.onCorpusChanged({
      workspaceId: input.workspaceId,
      change: "deleted",
    });
    const result = await this.documentRepository.deleteMissingPagesBySourceAndExternalIds(input);
    return result;
  }

  private async resolveSourceForInput(
    workspaceId: string,
    source: DocumentSourceResolverInput | undefined,
  ): Promise<{ sourceId?: string | null; source?: DocumentSourceSummary | null }> {
    if (!source) {
      return {};
    }
    const record = await this.requireDocumentSource(workspaceId, source);
    return {
      sourceId: record.id,
      source: toDocumentSourceSummary(record),
    };
  }

  private async requireDocumentSource(
    workspaceId: string,
    source: DocumentSourceResolverInput,
  ): Promise<DocumentOriginRecord> {
    if (!this.documentSourceRepository) {
      throw badRequest("Document sources are not configured");
    }

    if ("id" in source) {
      const existing = await this.documentSourceRepository.findByIdAndWorkspaceId(source.id, workspaceId);
      if (!existing) {
        throw notFound("Document source not found");
      }
      return existing;
    }

    if (source.kind === "connector") {
      return this.documentSourceRepository.upsertByExternalId({
        workspaceId,
        kind: "connector",
        name: source.name,
        externalId: source.externalId,
        config: source.config ?? {},
        metadata: source.metadata ?? {},
      });
    }

    const url = normalizeWebsiteSourceUrl(source.url);
    return this.documentSourceRepository.upsertByExternalId({
      workspaceId,
      kind: "website",
      name: deriveWebsiteSourceName(url),
      externalId: url,
      config: {
        url,
        ...(source.config ?? {}),
      },
      metadata: source.metadata ?? {},
    });
  }

  private async queueSnapshotMetadata(): Promise<{
    queuedJobCount?: number;
    processingJobCount?: number;
  }> {
    if (!this.getQueueSnapshot) {
      return {};
    }

    try {
      const snapshot = await this.getQueueSnapshot();
      return {
        queuedJobCount: snapshot.queuedJobCount,
        processingJobCount: snapshot.processingJobCount,
      };
    } catch {
      // Queue-depth metadata is best-effort observability and must not change request outcomes.
      return {};
    }
  }

  private async dispatchQueuedDocumentJob(input: {
    documentId: string;
    workspaceId: string;
    revision: number;
  }): Promise<void> {
    if (!this.jobRepository) {
      return;
    }

    try {
      const job = await this.jobRepository.findByDocumentRevision({
        documentId: input.documentId,
        workspaceId: input.workspaceId,
        documentRevision: input.revision,
      });
      if (!job) {
        return;
      }
      await this.jobDispatcher.dispatch(this.toDispatchRequest(job));
    } catch (error) {
      await this.auditService.record({
        workspaceId: input.workspaceId,
        eventType: "document.dispatch",
        eventStatus: "failure",
        metadata: {
          documentId: input.documentId,
          revision: input.revision,
          reason: error instanceof Error ? error.message : "Failed to dispatch document processing job",
        },
      });
    }
  }

  private toDispatchRequest(job: DocumentProcessingJobRecord) {
    return {
      jobId: job.id,
      documentId: job.documentId,
      workspaceId: job.workspaceId,
      revision: job.documentRevision,
    };
  }
}

const normalizeWebsiteSourceUrl = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw badRequest("source.url must be a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw badRequest("source.url must use http or https");
  }
  if (url.username || url.password) {
    throw badRequest("source.url must not include credentials");
  }
  url.hash = "";
  if (url.pathname === "/") {
    url.pathname = "";
  } else {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }
  return url.toString().replace(/\/$/, "");
};

const describeIndexedContent = (
  markdownContent: string,
  metadata?: Record<string, unknown>,
): {
  markdownContent: string;
  contentSizeBytes: number;
  contentHash: string;
} => {
  const normalizedMarkdown = normalizeMarkdown(markdownContent);
  // The content hash gates whether a re-ingest reprocesses (re-chunks + re-embeds).
  // Fold the searchable metadata projection into it so a metadata-only change —
  // e.g. an author becoming available on a re-sync — still re-embeds; otherwise
  // the new metadata never reaches the embedded search text. Size stays
  // content-only so storage quota accounting is unaffected.
  const metadataSearchText = renderMetadataSearchText(metadata ?? {});
  const fingerprint = metadataSearchText
    ? `${normalizedMarkdown}\u0000${metadataSearchText}`
    : normalizedMarkdown;
  return {
    markdownContent: normalizedMarkdown,
    contentSizeBytes: Buffer.byteLength(normalizedMarkdown, "utf8"),
    contentHash: createHash("sha256").update(fingerprint, "utf8").digest("hex"),
  };
};

const deriveWebsiteSourceName = (url: string): string => {
  const parsed = new URL(url);
  const path = parsed.pathname.replace(/^\/+/, "");
  return path ? `${parsed.hostname}/${path}` : parsed.hostname;
};

export const buildDocumentProcessingOptions = (input: {
  documentEnrichmentOverride?: DocumentProcessingJobOptions["documentEnrichmentOverride"];
}): DocumentProcessingJobOptions | null =>
  input.documentEnrichmentOverride
    ? { documentEnrichmentOverride: input.documentEnrichmentOverride }
    : null;
