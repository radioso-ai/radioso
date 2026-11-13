import type { DocumentSourceResolverInput, IndexedFieldValue } from "./documentContracts.js";
import type { DocumentImageCandidate } from "./documentImages.js";

export { documentInventoryStatuses } from "./documentContracts.js";

export type {
  ChunkDetail,
  ChunkMetadataRevisionPatch,
  ChunkRecord,
  ChunkRepositoryPort,
  ChunkSummary,
  PublishedChunkRecord,
  DocumentCreateInput,
  DocumentDerivedContentUpdateInput,
  DocumentEnrichmentMetadataUpdateInput,
  DocumentInventoryListInput,
  DocumentInventoryPort,
  DocumentPageState,
  DocumentRetrievalSettingsInput,
  DocumentQueueUpdateInput,
  DocumentRecord,
  DocumentRepositoryPort,
  BulkDocumentProcessingJobOptions,
  DocumentProcessingJobOptions,
  DocumentReviewedOperationApplyPort,
  DocumentReviewedOperationPreparationPort,
  DocumentReviewedWriteGuard,
  DocumentRetrievalSettingsResult,
  DocumentSourceResolverInput,
  DocumentSourceSummary,
  WorkspaceDocumentSourceStatus,
  DocumentSummaryRecord,
  DocumentUpdateInput,
  DocumentWorkspaceSummaryRecord,
  IndexedFieldValue,
} from "./documentContracts.js";
export type { DocumentSearchHistoryEntry } from "./historyTypes.js";
export type { DocumentJobDispatcherPort } from "../services/documentJobDispatcher.js";
export type {
  EmbeddingProfileJobCommitInput,
  EmbeddingProfileJobLoadInput,
  EmbeddingProfileJobLoadResult,
  EmbeddingProfileJobPersistencePort,
  EmbeddingProfileTerminalFailureKind,
  EmbeddingProfileTerminalFailurePort,
} from "../services/embeddingProfileJobService.js";
export type {
  DocumentStorageAdapter,
  DocumentStorageInventoryPort,
  DocumentStorageOwnersPort,
  DocumentStoragePort,
} from "./storage.js";
export { isCanonicalWorkspaceId } from "./storage.js";
export {
  DOCUMENT_IMAGE_RENDITION_WIDTHS,
  MAX_STORED_IMAGES_PER_DOCUMENT,
  type CapturableDocumentImage,
  type DocumentImageCandidate,
  type DocumentImageCandidateWriter,
  type DocumentImageCaptureStore,
  type DocumentImageEvidenceReader,
  type DocumentImageListing,
  type DocumentImageObjectLookup,
  type DocumentImageRows,
  type ListedDocumentImage,
  type DocumentImageRendition,
  type DocumentImageRole,
  type DocumentImageSummary,
  type PlacedDocumentImage,
  type ReleasedDocumentImageStore,
  type StoredDocumentImageRef,
} from "./documentImages.js";
export { MANUALLY_ADDED_DOCUMENTS_SOURCE_ID, documentSourceIdSchema } from "../domain/sourceConstants.js";
export {
  describeDocumentReviewedOperationPlan,
  documentReviewedChangeEffect,
  documentReviewedOperationPlanSchema,
  documentReviewedOperationTargetRefSchema,
} from "../services/documentReviewedOperationPlan.js";

export interface DocumentIngestionPort {
  ingest(input: {
    accountId?: string | null;
    workspaceId: string;
    title: string;
    content: string;
    metadata?: Record<string, unknown>;
    /**
     * Merged into the document's metadata, so operator rules address these by
     * their bare key. Unlike the rest of `metadata` — provenance the upstream
     * system rewrites on every save — a change to one of these re-indexes the
     * document, because retrieval reads them.
     */
    indexedFields?: Record<string, IndexedFieldValue>;
    externalDocumentId?: string | null;
    source?: DocumentSourceResolverInput;
    /**
     * The images the content names, by address: its metadata picture and the images in its text.
     * Absent means the source says nothing about images, and the document's images stay as they
     * are; an empty list means the content names none.
     */
    images?: readonly DocumentImageCandidate[];
  }): Promise<{ documentId: string; status: string }>;
}
