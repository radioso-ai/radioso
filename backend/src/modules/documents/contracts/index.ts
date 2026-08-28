import type { DocumentSourceResolverInput, IndexedFieldValue } from "./documentContracts.js";

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
  DocumentMetadataReplaceInput,
  DocumentDetails,
  DocumentListPage,
  DocumentQueueUpdateInput,
  DocumentRecord,
  DocumentRepositoryPort,
  DocumentProcessingJobEnrichmentOverride,
  DocumentProcessingJobOptions,
  DocumentRetrievalEligibilityInput,
  DocumentSourceInput,
  DocumentSourceKind,
  DocumentSourceRecord,
  DocumentSourceResolverInput,
  DocumentSourceSummary,
  WorkspaceDocumentSourceStatus,
  WorkspaceDocumentSourceStatusSummary,
  DocumentSummary,
  DocumentSummaryRecord,
  DocumentUpdateInput,
  DocumentWorkspaceSummaryRecord,
  IndexedFieldValue,
} from "./documentContracts.js";
export type { DocumentSearchHistoryEntry, DocumentSearchHistoryPage } from "./historyTypes.js";
export type { DocumentJobConsumerPort } from "../services/documentJobConsumer.js";
export type { DocumentJobDispatchRequest, DocumentJobDispatcherPort } from "../services/documentJobDispatcher.js";
export type {
  EmbeddingProfileJobCommitInput,
  EmbeddingProfileJobLoadInput,
  EmbeddingProfileJobLoadResult,
  EmbeddingProfileJobPersistencePort,
  EmbeddingProfileTerminalFailureKind,
  EmbeddingProfileTerminalFailurePort,
} from "../services/embeddingProfileJobService.js";
// The MCP converse HTTP surface holds this instance and renders its results; composition builds it.
export type {
  AgentConverseResourceDetail,
  AgentConverseResourceService,
  AgentConverseResourceSummary,
} from "../services/agentConverseResourceService.js";
export type {
  DocumentStorageDeleteInput,
  DocumentStoragePort,
  DocumentStorageReadInput,
  DocumentStorageUploadInput,
  StoredDocumentObject,
} from "./storage.js";
export { MANUALLY_ADDED_DOCUMENTS_SOURCE_ID } from "../domain/sourceConstants.js";

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
  }): Promise<{ documentId: string; status: string }>;
}
