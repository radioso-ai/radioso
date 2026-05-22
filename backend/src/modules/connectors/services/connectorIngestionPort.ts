import type { ConnectorIngestionPort, ConnectorSourceDescriptor } from "@radioso/connector-api";

import type {
  DocumentDeletionService,
  DocumentIngestionService,
} from "../../documents/composition.js";
import type { DocumentRepositoryPort } from "../../documents/contracts/index.js";

const toResolverInput = (source: ConnectorSourceDescriptor) =>
  ({
    kind: "connector" as const,
    externalId: source.externalId,
    name: source.name,
    config: source.config,
    metadata: source.metadata,
  });

/**
 * Adapter that exposes DocumentIngestionService + DocumentDeletionService to
 * connector plugins via the narrower ConnectorIngestionPort contract.
 *
 * Connectors never see the documents schema; they hand us a stable
 * external id and we own the rest (upsert, queueing, audit, capability checks).
 */
export const createConnectorIngestionPort = (deps: {
  documentIngestionService: Pick<DocumentIngestionService, "ingest" | "resolveSource">;
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
      ...(input.source ? { source: toResolverInput(input.source) } : {}),
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

  async ensureSource(input) {
    const record = await deps.documentIngestionService.resolveSource({
      workspaceId: input.workspaceId,
      source: toResolverInput(input.source),
    });
    return { id: record.id };
  },
});
