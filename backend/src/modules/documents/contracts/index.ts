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
  DocumentRetrievalSettingsInput,
  DocumentQueueUpdateInput,
  DocumentRecord,
  DocumentRepositoryPort,
  DocumentProcessingJobOptions,
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
  DocumentStoragePort,
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
