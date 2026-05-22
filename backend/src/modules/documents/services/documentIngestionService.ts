import type { AuditService } from "../../audit/contracts/index.js";
import type {
  DocumentProcessingJobRecord,
  DocumentProcessingJobRepositoryPort,
  DocumentProcessingQueueSnapshot,
} from "../../../db/repositories/documentProcessingJobRepository.js";
import { normalizeMarkdown } from "../../retrieval/public.js";
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
import { NoopUsageLimitPolicy, type UsageLimitPolicy } from "../../../shared/domain/usageLimitPolicy.js";
import { NoopDocumentJobDispatcher, type DocumentJobDispatcherPort } from "./documentJobDispatcher.js";
import { sanitizeInlineDocumentContent } from "./inlineDocumentContentSanitizer.js";

export type DocumentSourceKind = "inline_text" | "uploaded_file";
export type DocumentSourceResolverInput =
  | { id: string }
  | {
      kind: "website";
      url: string;
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
}

export interface DocumentSourceInput {
  sourceKind?: DocumentSourceKind;
  sourceFilename?: string | null;
  sourceMimeType?: string | null;
  sourceStorageBucket?: string | null;
  sourceStorageObject?: string | null;
  sourceStorageGeneration?: string | null;
  sourceSizeBytes?: number | null;
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

export interface ChunkRecord {
  id: string;
  documentId: string;
  workspaceId: string;
  chunkIndex: number;
  content: string;
  searchText?: string | null;
  embedding: number[];
  startOffset: number;
  endOffset: number;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

export interface DocumentRepositoryPort {
  createAndQueue(input: DocumentCreateInput): Promise<DocumentRecord>;
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
  findByExternalDocumentId(
    workspaceId: string,
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
  requeue(documentId: string, workspaceId: string): Promise<DocumentRecord>;
  requeueAndQueue(documentId: string, workspaceId: string): Promise<DocumentRecord>;
  requeueAllEligibleAndQueue(workspaceId: string): Promise<{
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
}

export interface DocumentWorkspaceSummaryRecord {
  documentCount: number;
  readyDocumentCount: number;
  pendingDocumentCount: number;
  sampleDocumentCount: number;
  sampleDocumentSlugs: string[];
}

export interface ChunkRepositoryPort {
  replaceForDocument(documentId: string, chunks: ChunkRecord[]): Promise<void>;
  publishForDocumentRevision(input: {
    documentId: string;
    workspaceId: string;
    revision: number;
    chunks: ChunkRecord[];
  }): Promise<boolean>;
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
}

export interface DocumentListPage {
  documents: DocumentSummary[];
  total: number;
  nextCursor: string | null;
  hasMore: boolean;
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
  ) {}

  async ingest(input: {
    workspaceId: string;
    accountId?: string | null;
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

    try {
      document = await this.documentRepository.createAndQueue({
        workspaceId: input.workspaceId,
        title: input.title,
        sourceContent: sanitizedContent.sourceContent,
        markdownContent: normalizeMarkdown(sanitizedContent.markdownContent),
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
      });

    } catch (error) {
      await usageReservation.release();
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

    return {
      documentId: document.id,
      status: document.status,
    };
  }

  async update(input: {
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
    let document:
      | {
          id: string;
          sourceId?: string | null;
          externalDocumentId?: string | null;
          revision: number;
          status: string;
        }
      | undefined;

    try {
      const existing = await this.getDocument(input.workspaceId, input.documentId);
      if (existing.sourceKind === "uploaded_file") {
        throw conflict("Imported documents cannot be updated through the inline document API");
      }
      if (
        existing.externalDocumentId &&
        input.externalDocumentId !== undefined &&
        input.externalDocumentId !== existing.externalDocumentId
      ) {
        throw conflict("externalDocumentId cannot be changed once set");
      }

      document = await this.documentRepository.updateAndQueue({
        documentId: input.documentId,
        workspaceId: input.workspaceId,
        title: input.title,
        sourceContent: sanitizedContent.sourceContent,
        markdownContent: normalizeMarkdown(sanitizedContent.markdownContent),
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
      });

    } catch (error) {
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

    return {
      documentId: document.id,
      status: document.status,
    };
  }

  async reprocess(input: { workspaceId: string; documentId: string }): Promise<{ documentId: string; status: string }> {
    await this.getDocument(input.workspaceId, input.documentId);

    let document:
      | {
          id: string;
          revision: number;
          status: string;
        }
      | undefined;

    try {
      document = await this.documentRepository.requeueAndQueue(input.documentId, input.workspaceId);
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
      contentSize: document.contentSize ?? null,
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

const deriveWebsiteSourceName = (url: string): string => {
  const parsed = new URL(url);
  const path = parsed.pathname.replace(/^\/+/, "");
  return path ? `${parsed.hostname}/${path}` : parsed.hostname;
};
