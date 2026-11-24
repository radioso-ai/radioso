import type { DocumentSourceListRecord } from "../../../db/repositories/documentSourceRepository.js";
import type { WorkspaceDocumentSourceStatus } from "../contracts/documentContracts.js";

/** A stored source, with its document count, as the content-free state REST and Ray read. */
export const toWorkspaceDocumentSourceStatus = (source: DocumentSourceListRecord): WorkspaceDocumentSourceStatus => ({
  id: source.id,
  kind: source.kind,
  name: source.name,
  externalId: source.externalId,
  config: source.config,
  lastSyncStatus: source.lastSyncStatus,
  lastSyncedAt: source.lastSyncedAt,
  recrawlCadence: source.recrawlCadence,
  nextRecrawlAt: source.nextRecrawlAt,
  documentCount: source.documentCount,
  createdAt: source.createdAt,
  updatedAt: source.updatedAt,
});
