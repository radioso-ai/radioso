import type { EmbeddingSpaceRef } from "../../embeddingProfiles/contracts/embeddingConsumers.js";
import type { DocumentEnrichmentProvenance } from "../domain/enrichment/documentEnrichmentContract.js";

export type DocumentSourceKind = "inline_text" | "uploaded_file";

export type DocumentProcessingJobEnrichmentOverride = "on" | "off";

export interface DocumentProcessingJobOptions {
  documentEnrichmentOverride?: DocumentProcessingJobEnrichmentOverride;
}

export interface DocumentSourceSummary {
  id: string;
  kind: "website" | "api" | "connector" | "upload";
  name: string;
  externalId: string | null;
}

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
  /** See `DocumentMetadataReplaceInput.enrichment`: ownership relinquishment rides with the write. */
  enrichment?: Record<string, unknown>;
  externalDocumentId?: string | null;
}

export interface DocumentDerivedContentUpdateInput {
  documentId: string;
  workspaceId: string;
  revision: number;
  sourceContent: string;
  markdownContent: string;
}

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
  enrichment?: Record<string, unknown> | null;
}

export interface DocumentMetadataReplaceInput {
  documentId: string;
  workspaceId: string;
  metadata: Record<string, unknown>;
  /**
   * Replacement enrichment provenance, written in the same statement as the
   * metadata. A manual write that changes or removes a key extraction
   * generated relinquishes ownership of it here, so the next processing pass
   * treats it as operator-owned. Omitted leaves stored provenance untouched.
   */
  enrichment?: Record<string, unknown>;
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
  findByExternalDocumentId(workspaceId: string, externalDocumentId: string): Promise<DocumentRecord | null>;
  findBySourceAndExternalDocumentId(
    workspaceId: string,
    sourceId: string,
    externalDocumentId: string,
  ): Promise<DocumentRecord | null>;
  listSummariesByIdsAndWorkspaceId(workspaceId: string, documentIds: string[]): Promise<DocumentSummaryRecord[]>;
  listSummariesByStatus(
    workspaceId: string,
    statuses: ReadonlyArray<string>,
    input: { limit: number },
  ): Promise<DocumentSummaryRecord[]>;
  listSummaryPageByWorkspaceId(
    workspaceId: string,
    input: { limit: number; offset?: number; cursor?: string },
  ): Promise<{ documents: DocumentSummaryRecord[]; total: number; nextCursor: string | null; hasMore: boolean }>;
  update(input: DocumentUpdateInput): Promise<DocumentRecord>;
  updateAndQueue(input: DocumentQueueUpdateInput): Promise<DocumentRecord>;
  updateDerivedContentForRevision(input: DocumentDerivedContentUpdateInput): Promise<DocumentRecord | null>;
  updateMetadataForRevision(input: DocumentEnrichmentMetadataUpdateInput): Promise<DocumentRecord | null>;
  /**
   * Replaces the operator-authored metadata map and requeues the document.
   * Metadata reaches the chunks only at vectorize time, so a replace without a
   * requeue would leave the published chunks carrying the previous tags.
   */
  updateMetadataAndQueue(input: DocumentMetadataReplaceInput): Promise<DocumentRecord>;
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
    /** null selects the manually added documents, which have no source row. */
    sourceId: string | null;
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
  failedDocumentCount: number;
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
  listForDocumentRevision(input: { documentId: string; workspaceId: string }): Promise<PublishedChunkRecord[]>;
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
  reconcileWorkspace(workspaceId: string): Promise<{ enqueued: number; skipped: number }>;
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

/**
 * A value an upstream system publishes for retrieval to filter and boost on — a
 * product's price, a catalogue item's stock status. Scalars only: metadata rules
 * compare a single value per key, so an array or a nested object never matches.
 */
export type IndexedFieldValue = string | number | boolean;
