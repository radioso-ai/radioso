export type {
  ChunkRecord,
  ChunkRepositoryPort,
  DocumentCreateInput,
  DocumentDerivedContentUpdateInput,
  DocumentDetails,
  DocumentListPage,
  DocumentQueueUpdateInput,
  DocumentRecord,
  DocumentRepositoryPort,
  DocumentSourceInput,
  DocumentSourceKind,
  DocumentSourceRecord,
  DocumentSummary,
  DocumentSummaryRecord,
  DocumentUpdateInput,
  DocumentWorkspaceSummaryRecord,
} from "../services/documentIngestionService.js";
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

export interface DocumentIngestionPort {
  ingest(input: {
    accountId?: string | null;
    workspaceId: string;
    title: string;
    content: string;
    metadata?: Record<string, unknown>;
    externalDocumentId?: string | null;
  }): Promise<{ documentId: string; status: string }>;
}
