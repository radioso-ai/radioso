import type {
  ConnectorIngestionPort,
  ConnectorSourceDescriptor,
  ConnectorSourceReference,
} from "@radioso/connector-api";

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

// A descriptor resolves by upsert, so it registers a missing source; a reference
// resolves by id, so a source deleted since the connector read it stays deleted.
const toResolverInput = (
  source: ConnectorSourceDescriptor | ConnectorSourceReference,
): DocumentSourceResolverInput =>
  "externalId" in source
    ? {
        kind: "connector" as const,
        externalId: source.externalId,
        name: source.name,
        config: source.config,
        metadata: source.metadata,
      }
    : { id: source.id };

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
      ...(input.indexedFields ? { indexedFields: input.indexedFields } : {}),
      ...(input.source ? { source: toResolverInput(input.source) } : {}),
      // A connector's pictures are of the item itself, so each is a document's primary image.
      ...(input.images
        ? { images: input.images.map((image) => ({ sourceUrl: image.url, role: "primary" as const, alt: image.alt ?? "" })) }
        : {}),
    });
  },

  async deleteByExternalId(input) {
    // A deleted source took its documents with it, so a reference to one finds nothing.
    const sourceId =
      "externalId" in input.source
        ? (
            await deps.documentIngestionService.resolveSource({
              workspaceId: input.workspaceId,
              source: toResolverInput(input.source),
            })
          ).id
        : input.source.id;
    const existing = await deps.documentRepository.findBySourceAndExternalDocumentId(
      input.workspaceId,
      sourceId,
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
