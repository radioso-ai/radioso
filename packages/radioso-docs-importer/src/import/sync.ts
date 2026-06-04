import type { DocumentInput } from "./buildDocuments.ts";
import type { ExistingDocument, RadiosoDocsClient } from "../radioso/client.ts";

export interface SyncOptions {
  prune: boolean;
  /**
   * Sections eligible for pruning — exactly the sections that were imported this
   * run. A partial import (e.g. `--no-api`) must never prune the section it did
   * not build, otherwise it would wipe the other source set.
   */
  pruneSections: Set<string>;
}

export interface SyncReport {
  upserted: number;
  pruned: number;
  prunedIds: string[];
  prunedSourceIds: string[];
}

type Logger = (message: string) => void;

/**
 * Upsert every desired document, then (optionally) prune workspace documents we
 * previously imported that are no longer present. Pruning is scoped to documents
 * carrying one of our owned `metadata.section` values, so it can never delete
 * content the importer did not create.
 */
export async function syncDocuments(
  client: RadiosoDocsClient,
  desired: DocumentInput[],
  options: SyncOptions,
  log: Logger = () => {},
): Promise<SyncReport> {
  let firstDocumentId: string | null = null;
  for (const document of desired) {
    const result = await client.create(document);
    if (firstDocumentId === null) {
      firstDocumentId = result.documentId;
    }
    log(`upserted ${document.externalDocumentId} (${result.status})`);
  }

  const report: SyncReport = { upserted: desired.length, pruned: 0, prunedIds: [], prunedSourceIds: [] };
  if (!options.prune) {
    return report;
  }

  const existing = await client.listAll();
  const desiredIds = new Set(desired.map((document) => document.externalDocumentId));
  const commonSourceId = resolveCommonSourceId(existing, firstDocumentId, desiredIds);
  const stale = existing.filter(
    (document) =>
      inPruneScope(document, options.pruneSections) &&
      (!isDesired(document, desiredIds) || (commonSourceId !== null && document.sourceId !== commonSourceId)),
  );
  const legacySourceIds = new Set<string>();

  for (const document of stale) {
    await client.delete(document.id);
    report.pruned += 1;
    report.prunedIds.push(document.id);
    log(`pruned ${document.externalDocumentId ?? document.id}`);
    if (commonSourceId !== null && isLegacySource(document.sourceId, commonSourceId)) {
      legacySourceIds.add(document.sourceId);
    }
  }

  // These legacy per-page sources were created only for importer-owned docs; after
  // pruning those docs, the sources are empty and safe to remove.
  for (const sourceId of legacySourceIds) {
    await client.deleteSource(sourceId);
    report.prunedSourceIds.push(sourceId);
    log(`pruned source ${sourceId}`);
  }

  return report;
}

const MANUAL_SOURCE_ID = "00000000-0000-0000-0000-000000000001";

function inPruneScope(document: ExistingDocument, pruneSections: Set<string>): boolean {
  const section = document.metadata?.section;
  return typeof section === "string" && pruneSections.has(section);
}

function isDesired(document: ExistingDocument, desiredIds: Set<string>): boolean {
  return document.externalDocumentId !== null && desiredIds.has(document.externalDocumentId);
}

/**
 * Identify the single common source we just upserted into. Resolved from the id of
 * the importer's own freshly-created document — unambiguous even during the migration
 * window when each `externalDocumentId` still has a legacy duplicate under an old
 * per-page source. Falls back to a desired-doc lookup only if that id is not yet
 * visible in the listing.
 */
function resolveCommonSourceId(
  existing: ExistingDocument[],
  firstDocumentId: string | null,
  desiredIds: Set<string>,
): string | null {
  if (firstDocumentId !== null) {
    const created = existing.find((candidate) => candidate.id === firstDocumentId);
    if (created?.sourceId) {
      return created.sourceId;
    }
  }
  const document = existing.find(
    (candidate) => candidate.externalDocumentId !== null && desiredIds.has(candidate.externalDocumentId) && candidate.sourceId,
  );
  return document?.sourceId ?? null;
}

function isLegacySource(sourceId: string | null, commonSourceId: string): sourceId is string {
  return sourceId !== null && sourceId !== commonSourceId && sourceId !== MANUAL_SOURCE_ID;
}
