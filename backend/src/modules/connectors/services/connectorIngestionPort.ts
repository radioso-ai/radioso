import type { ConnectorIngestionPort, ConnectorSourceDescriptor } from "@radioso/connector-api";

import type {
  DocumentIngestionPort,
  DocumentRepositoryPort,
  DocumentSourceResolverInput,
} from "../../documents/contracts/index.js";

interface ConnectorDocumentIngestionPort extends DocumentIngestionPort {
  resolveSource(input: {
    workspaceId: string;
    source: DocumentSourceResolverInput;
  }): Promise<{ id: string }>;
}

interface ConnectorDocumentDeletionPort {
  delete(input: { workspaceId: string; documentId: string }): Promise<void>;
}

const toResolverInput = (source: ConnectorSourceDescriptor) =>
  ({
    kind: "connector" as const,
    externalId: source.externalId,
    name: source.name,
    config: source.config,
    metadata: source.metadata,
  });

/**
 * Narrow view of the application's HTML-to-text capability. The composition
 * layer satisfies it with `RadiosoCrawlerUtilityProvider.extractTextFromHtml`,
 * which is the one place allowed to reach into `@radioso/crawler`. Connectors
 * never see the underlying provider — they just declare `contentFormat: "html"`
 * on their ingest call and the adapter takes care of the rest.
 */
export interface HtmlContentNormalizer {
  extractTextFromHtml(html: string): Promise<string>;
}

/**
 * Adapter that exposes DocumentIngestionService + DocumentDeletionService to
 * connector plugins via the narrower ConnectorIngestionPort contract.
 *
 * Connectors never see the documents schema; they hand us a stable
 * external id and we own the rest (upsert, queueing, audit, capability checks).
 */
export const createConnectorIngestionPort = (deps: {
  documentIngestionService: ConnectorDocumentIngestionPort;
  documentDeletionService: ConnectorDocumentDeletionPort;
  documentRepository: Pick<DocumentRepositoryPort, "findBySourceAndExternalDocumentId">;
  htmlContentNormalizer: HtmlContentNormalizer;
}): ConnectorIngestionPort => ({
  async ingest(input) {
    const content =
      input.contentFormat === "html"
        ? await deps.htmlContentNormalizer.extractTextFromHtml(input.content)
        : input.content;
    return deps.documentIngestionService.ingest({
      workspaceId: input.workspaceId,
      title: input.title,
      content,
      externalDocumentId: input.externalDocumentId,
      metadata: input.metadata,
      ...(input.source ? { source: toResolverInput(input.source) } : {}),
    });
  },

  async deleteByExternalId(input) {
    const source = await deps.documentIngestionService.resolveSource({
      workspaceId: input.workspaceId,
      source: toResolverInput(input.source),
    });
    const existing = await deps.documentRepository.findBySourceAndExternalDocumentId(
      input.workspaceId,
      source.id,
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
