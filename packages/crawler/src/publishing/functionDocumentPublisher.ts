import type {
  DocumentPublicationEnvelope,
  DocumentPublisher,
  DocumentPublisherResult
} from "../types.js";

export const createFunctionDocumentPublisher = (handlers: {
  upsert: (document: DocumentPublicationEnvelope) => Promise<DocumentPublisherResult>;
  remove: (input: { externalId: string }) => Promise<void>;
}): DocumentPublisher => ({
  upsert: handlers.upsert,
  remove: handlers.remove
});
