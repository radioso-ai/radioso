import { createHash } from "node:crypto";

import {
  createNoopWorkspaceInvalidationPublisher,
  type WorkspaceInvalidationPublisher,
} from "@radioso/workspace-invalidation-contract";

import type { AuditService } from "../../audit/contracts/index.js";
import type {
  DocumentProcessingJobRecord,
  DocumentProcessingJobRepositoryPort,
  DocumentProcessingQueueSnapshot,
} from "../../../db/repositories/documentProcessingJobRepository.js";
import { normalizeMarkdown, renderMetadataSearchText } from "../../retrieval/public.js";
import { badRequest, conflict, notFound } from "../../../shared/domain/errors.js";
import {
  toDocumentSourceSummary,
  type DocumentSourceRecord as DocumentOriginRecord,
  type DocumentSourceRepositoryPort,
} from "../../../db/repositories/documentSourceRepository.js";
import type {
  DocumentProcessingJobOptions,
  DocumentSourceSummary,
} from "../contracts/documentContracts.js";
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
import { relinquishGeneratedKeys } from "../domain/enrichment/generatedTagOwnership.js";
import type { DocumentEnrichmentProvenance } from "../domain/enrichment/documentEnrichmentContract.js";
import type {
  DocumentDetails,
  DocumentListPage,
  DocumentRecord,
  DocumentRepositoryPort,
  DocumentSourceResolverInput,
  DocumentSummary,
  DocumentSummaryRecord,
  DocumentWorkspaceSummaryRecord,
  EmbeddingCoverageReconciliationPort,
  IndexedFieldValue,
  WorkspaceDocumentSourceStatusSummary,
} from "../contracts/documentContracts.js";

export type {
  ChunkDetail,
  ChunkMetadataRevisionPatch,
  ChunkRecord,
  ChunkRepositoryPort,
  ChunkSummary,
  DocumentCreateInput,
  DocumentDerivedContentUpdateInput,
  DocumentDetails,
  DocumentEnrichmentMetadataUpdateInput,
  DocumentListPage,
  DocumentQueueUpdateInput,
  DocumentRecord,
  DocumentRepositoryPort,
  DocumentRetrievalEligibilityInput,
  DocumentSourceInput,
  DocumentSourceKind,
  DocumentSourceResolverInput,
  DocumentSourceRecord,
  DocumentSummary,
  DocumentSummaryRecord,
  DocumentUpdateInput,
  DocumentWorkspaceSummaryRecord,
  EmbeddingCoverageReconciliationPort,
  PublishedChunkRecord,
} from "../contracts/documentContracts.js";

/**
 * Builds the optional `enrichment` field of a document write: present only when
 * the manual metadata changed or removed a key extraction generated, so the
 * write relinquishes ownership of that key in the same statement.
 */
const relinquishedEnrichment = (
  existing: { enrichment?: DocumentEnrichmentProvenance | null; metadata?: Record<string, unknown> | null },
  nextMetadata: Record<string, unknown> | undefined,
): { enrichment?: Record<string, unknown> } => {
  if (nextMetadata === undefined) {
    return {};
  }
  const relinquished = relinquishGeneratedKeys({
    previousProvenance: existing.enrichment,
    previousMetadata: existing.metadata ?? {},
    nextMetadata,
  });
  return relinquished ? { enrichment: relinquished as unknown as Record<string, unknown> } : {};
};

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
    private readonly workspaceInvalidationPublisher: WorkspaceInvalidationPublisher =
      createNoopWorkspaceInvalidationPublisher(),
  ) {}

  async ingest(input: {
    workspaceId: string;
    accountId?: string | null;
    title: string;
    content: string;
    metadata?: Record<string, unknown>;
    indexedFields?: Record<string, IndexedFieldValue>;
    externalDocumentId?: string | null;
    source?: DocumentSourceResolverInput;
    documentEnrichmentOverride?: DocumentProcessingJobOptions["documentEnrichmentOverride"];
  }): Promise<{ documentId: string; status: string }> {
    const metadata = mergeIndexedFields(input.metadata, input.indexedFields);
    const sanitizedContent = sanitizeInlineDocumentContent({
      title: input.title,
      sourceContent: input.content,
      metadata,
    });
    const indexedContent = describeIndexedContent(
      sanitizedContent.markdownContent,
      metadata,
      input.indexedFields,
    );
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
        metadata,
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

    this.publishDocumentStatusChanged(input.workspaceId);
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
        ...relinquishedEnrichment(existing, input.metadata),
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

    this.publishDocumentStatusChanged(input.workspaceId);
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

  // Replace a document's operator-authored metadata map. Document tags are
  // projected onto the chunks at vectorize time, so the replace requeues the
  // document rather than writing the map in place; the published chunks would
  // otherwise keep carrying the previous tags. Unlike the inline update path,
  // this is allowed for imported documents — it never touches their content.
  async updateMetadata(input: {
    workspaceId: string;
    documentId: string;
    metadata: Record<string, unknown>;
  }): Promise<DocumentDetails> {
    const existing = await this.documentRepository.findByIdAndWorkspaceId(input.documentId, input.workspaceId);
    if (!existing) {
      throw notFound("Document not found");
    }

    let updated: DocumentRecord;
    try {
      updated = await this.documentRepository.updateMetadataAndQueue({
        documentId: input.documentId,
        workspaceId: input.workspaceId,
        metadata: input.metadata,
        ...relinquishedEnrichment(existing, input.metadata),
      });
    } catch (error) {
      await this.auditService.record({
        workspaceId: input.workspaceId,
        eventType: "document.metadata.update",
        eventStatus: "failure",
        metadata: {
          documentId: input.documentId,
          reason: error instanceof Error ? error.message : "Failed to update document metadata",
        },
      });
      throw error;
    }

    this.publishDocumentStatusChanged(input.workspaceId);
    await this.auditService.record({
      workspaceId: input.workspaceId,
      eventType: "document.metadata.update",
      eventStatus: "success",
      metadata: {
        documentId: updated.id,
        revision: updated.revision,
        status: updated.status,
        metadataKeyCount: Object.keys(input.metadata).length,
        ...(await this.queueSnapshotMetadata()),
      },
    });
    await this.dispatchQueuedDocumentJob({
      documentId: updated.id,
      workspaceId: input.workspaceId,
      revision: updated.revision,
    });

    return this.toDetails(updated);
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

    this.publishDocumentStatusChanged(input.workspaceId);
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

    this.publishDocumentStatusChanged(input.workspaceId);
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

  async summarizeWorkspace(workspaceId: string): Promise<DocumentWorkspaceSummaryRecord> {
    return this.documentRepository.summarizeWorkspace(workspaceId);
  }

  /** Documents owns this source summary so REST and Ray cannot query source persistence directly. */
  async summarizeSourcesForWorkspace(workspaceId: string): Promise<WorkspaceDocumentSourceStatusSummary> {
    if (!this.documentSourceRepository) {
      return { sources: [], documentsWithoutSourceCount: 0 };
    }
    const [sources, documentsWithoutSourceCount] = await Promise.all([
      this.documentSourceRepository.listByWorkspaceIdWithDocumentCounts(workspaceId),
      this.documentSourceRepository.countDocumentsWithoutSource(workspaceId),
    ]);
    return {
      sources: sources.map((source) => ({
        id: source.id,
        kind: source.kind,
        name: source.name,
        externalId: source.externalId,
        config: source.config,
        lastSyncStatus: source.lastSyncStatus,
        lastSyncedAt: source.lastSyncedAt,
        documentCount: source.documentCount,
        createdAt: source.createdAt,
        updatedAt: source.updatedAt,
      })),
      documentsWithoutSourceCount,
    };
  }

  /**
   * Ingestion-state read for operability surfaces (needs-attention lists). It is
   * deliberately not paginated or routable: callers ask for a small, bounded
   * newest-first slice of documents sitting in the given processing states.
   */
  async listByStatuses(
    workspaceId: string,
    statuses: ReadonlyArray<string>,
    input: { limit: number },
  ): Promise<DocumentSummary[]> {
    const documents = await this.documentRepository.listSummariesByStatus(workspaceId, statuses, input);
    return documents.map((document) => this.toSummary(document));
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
      this.publishDocumentStatusChanged(input.workspaceId);
    }
    if (input.documentStorage && storageRefs.length > 0) {
      await Promise.allSettled(
        storageRefs.map((ref) => input.documentStorage!.delete(ref)),
      );
    }
    const deletedSource = await this.documentSourceRepository?.deleteByIdAndWorkspaceId(
      input.sourceId,
      input.workspaceId,
    );
    if (deletedSource) {
      this.publishDocumentStatusChanged(input.workspaceId);
    }
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
    const result = await this.documentRepository.deleteMissingPagesBySourceAndExternalIds(input);
    if (result.deletedCount > 0) {
      this.publishDocumentStatusChanged(input.workspaceId);
    }
    return result;
  }

  private publishDocumentStatusChanged(workspaceId: string): void {
    this.workspaceInvalidationPublisher.enqueue(workspaceId, ["document.status_changed"]);
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

// Indexed fields share the flat metadata map so operator rules address them by
// their bare key. The connector's own metadata is written last: a shop that
// publishes its own `author` or `dateFrom` must not overwrite what the
// connector derived for those platform-owned keys.
const mergeIndexedFields = (
  metadata: Record<string, unknown> | undefined,
  indexedFields: Record<string, IndexedFieldValue> | undefined,
): Record<string, unknown> | undefined => {
  if (!indexedFields || Object.keys(indexedFields).length === 0) {
    return metadata;
  }
  return { ...indexedFields, ...(metadata ?? {}) };
};

// Key order is whatever the upstream happened to serialize, so sort before
// hashing or a reordered payload would look like an edit. Code-unit order
// rather than locale order: the same payload has to hash the same everywhere
// the worker runs.
//
// JSON rather than joined text, because the hash decides whether a re-sync is
// skipped and a value's type is part of what changed: a shop that starts
// sending the number 17 where it sent the string "17" changes what a numeric
// rule matches. JSON also escapes the value, so no field can spell out its
// neighbours and hash as them.
const renderIndexedFieldsFingerprint = (
  indexedFields: Record<string, IndexedFieldValue> | undefined,
): string => {
  const entries = Object.entries(indexedFields ?? {}).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  // An empty map has to render empty, so a document that carries no indexed
  // fields keeps the hash it already had.
  return entries.length > 0 ? JSON.stringify(entries) : "";
};

const describeIndexedContent = (
  markdownContent: string,
  metadata?: Record<string, unknown>,
  indexedFields?: Record<string, IndexedFieldValue>,
): {
  markdownContent: string;
  contentSizeBytes: number;
  contentHash: string;
} => {
  const normalizedMarkdown = normalizeMarkdown(markdownContent);
  // The content hash gates whether a re-ingest reprocesses (re-chunks + re-embeds).
  // Fold the searchable metadata projection into it so a metadata-only change —
  // e.g. an author becoming available on a re-sync — still re-embeds; otherwise
  // the new metadata never reaches the embedded search text. Indexed fields join
  // it for the same reason: retrieval filters on them, so a price that moves
  // without a body edit has to reach the chunks. The rest of `metadata` stays
  // out — a modification stamp changes on every save and would re-embed
  // documents nobody edited. Size stays content-only so storage quota
  // accounting is unaffected.
  const fingerprint = [
    normalizedMarkdown,
    renderMetadataSearchText(metadata ?? {}),
    renderIndexedFieldsFingerprint(indexedFields),
  ]
    .filter((part) => part.length > 0)
    .join("\u0000");
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
