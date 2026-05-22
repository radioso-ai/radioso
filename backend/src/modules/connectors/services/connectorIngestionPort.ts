import type { ConnectorIngestionPort } from "@radioso/connector-api";

import type {
  DocumentDeletionService,
  DocumentIngestionService,
} from "../../documents/composition.js";
import type { DocumentRepositoryPort } from "../../documents/contracts/index.js";

/**
 * Adapter that exposes DocumentIngestionService + DocumentDeletionService to
 * connector plugins via the narrower ConnectorIngestionPort contract.
 *
 * Connectors never see the documents schema; they hand us a stable
 * external id and we own the rest (upsert, queueing, audit, capability checks).
 */
export const createConnectorIngestionPort = (deps: {
  documentIngestionService: Pick<DocumentIngestionService, "ingest">;
  documentDeletionService: Pick<DocumentDeletionService, "delete">;
  documentRepository: Pick<DocumentRepositoryPort, "findByExternalDocumentId">;
}): ConnectorIngestionPort => ({
  async ingest(input) {
    return deps.documentIngestionService.ingest({
      workspaceId: input.workspaceId,
      title: input.title,
      content: input.content,
      externalDocumentId: input.externalDocumentId,
      metadata: input.metadata,
    });
  },

  async deleteByExternalId(input) {
    const existing = await deps.documentRepository.findByExternalDocumentId(
      input.workspaceId,
      input.externalDocumentId,
    );
    if (!existing) {
      return false;
    }
    await deps.documentDeletionService.delete({
      workspaceId: input.workspaceId,
      documentId: existing.id,
    });
    return true;
  },
});
