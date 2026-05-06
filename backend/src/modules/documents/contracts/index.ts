export type { DocumentJobConsumerPort } from "../services/documentJobConsumer.js";
export type { DocumentJobDispatcherPort } from "../services/documentJobDispatcher.js";

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
