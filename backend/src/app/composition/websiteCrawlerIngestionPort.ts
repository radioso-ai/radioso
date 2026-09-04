import type { WebsiteCrawlerDocumentIngestionPort } from "../../modules/websiteCrawler/public.js";

/**
 * Adapts the ingestion service into the crawler's port.
 *
 * The port is a structural interface, so a service instance satisfies it directly — and that is the
 * trap: the instance's methods resolve their collaborators through `this`, so a consumer that holds
 * one of them as a value loses the receiver and fails at runtime, with nothing in the type system or
 * in a `vi.fn()`-shaped test double to say so. Composition hands over closures instead, so the
 * crawler cannot lose a receiver it never held.
 */
export const createWebsiteCrawlerIngestionPort = (
  documentIngestionService: Required<WebsiteCrawlerDocumentIngestionPort>,
): WebsiteCrawlerDocumentIngestionPort => ({
  ingest: (input) => documentIngestionService.ingest(input),
  resolveSource: (input) => documentIngestionService.resolveSource(input),
  updateSourceSyncState: (input) => documentIngestionService.updateSourceSyncState(input),
  reapMissingPages: (input) => documentIngestionService.reapMissingPages(input),
});
