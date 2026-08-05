import type { DocumentSourceResolverInput } from "./documentContracts.js";

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
  DocumentDetails,
  DocumentListPage,
  DocumentQueueUpdateInput,
  DocumentRecord,
  DocumentRepositoryPort,
  DocumentRetrievalEligibilityInput,
  DocumentSourceInput,
  DocumentSourceKind,
  DocumentSourceRecord,
  DocumentSourceResolverInput,
  DocumentSummary,
  DocumentSummaryRecord,
  DocumentUpdateInput,
  DocumentWorkspaceSummaryRecord,
} from "./documentContracts.js";
export type { DocumentSearchHistoryEntry, DocumentSearchHistoryPage } from "./historyTypes.js";
export type { DocumentJobConsumerPort } from "../services/documentJobConsumer.js";
export type { DocumentJobDispatchRequest, DocumentJobDispatcherPort } from "../services/documentJobDispatcher.js";
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
    externalDocumentId?: string | null;
    source?: DocumentSourceResolverInput;
  }): Promise<{ documentId: string; status: string }>;
}
