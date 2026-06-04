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
 * Upsert every desired document, pruning as we go. During source migrations the
 * backend treats the same externalDocumentId under a new source as a new row, so
 * a full upload-then-prune pass can temporarily double the importer-owned corpus
 * and trip workspace document quotas.
 */
export async function syncDocuments(
  client: RadiosoDocsClient,
  desired: DocumentInput[],
  options: SyncOptions,
  log: Logger = () => {},
): Promise<SyncReport> {
  const report: SyncReport = { upserted: 0, pruned: 0, prunedIds: [], prunedSourceIds: [] };
  const desiredIds = new Set(desired.map((document) => document.externalDocumentId));
  let commonSourceId: string | null = null;

  if (options.prune) {
    const existing = await client.listAll();
    await pruneDocuments(
      client,
      existing,
      selectStaleDocuments(existing, desiredIds, options.pruneSections, commonSourceId, commonDesiredIds(existing, commonSourceId)),
      report,
      log,
      commonSourceId,
    );
  }

  for (const document of desired) {
    const result = await client.create(document);
    report.upserted += 1;
    log(`upserted ${document.externalDocumentId} (${result.status})`);

    if (options.prune) {
      const existing = await client.listAll();
      commonSourceId = commonSourceId ?? resolveCommonSourceId(existing, result.documentId);
      await pruneDocuments(
        client,
        existing,
        selectStaleDocuments(existing, desiredIds, options.pruneSections, commonSourceId, new Set([document.externalDocumentId])),
        report,
        log,
        commonSourceId,
      );
    }
  }

  if (options.prune) {
    const existing = await client.listAll();
    commonSourceId = commonSourceId ?? resolveCommonSourceId(existing, null);
    await pruneDocuments(
      client,
      existing,
      selectStaleDocuments(existing, desiredIds, options.pruneSections, commonSourceId, null),
      report,
      log,
      commonSourceId,
    );
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

function commonDesiredIds(existing: ExistingDocument[], commonSourceId: string | null): Set<string> {
  const ids = new Set<string>();
  if (commonSourceId === null) {
    return ids;
  }
  for (const document of existing) {
    if (document.sourceId === commonSourceId && document.externalDocumentId !== null) {
      ids.add(document.externalDocumentId);
    }
  }
  return ids;
}

function selectStaleDocuments(
  existing: ExistingDocument[],
  desiredIds: Set<string>,
  pruneSections: Set<string>,
  commonSourceId: string | null,
  migratedDesiredIds: Set<string> | null,
): ExistingDocument[] {
  return existing.filter((document) => {
    if (!inPruneScope(document, pruneSections)) {
      return false;
    }
    if (!isDesired(document, desiredIds)) {
      return true;
    }
    return (
      commonSourceId !== null &&
      document.externalDocumentId !== null &&
      document.sourceId !== commonSourceId &&
      (migratedDesiredIds === null || migratedDesiredIds.has(document.externalDocumentId))
    );
  });
}

async function pruneDocuments(
  client: RadiosoDocsClient,
  existing: ExistingDocument[],
  stale: ExistingDocument[],
  report: SyncReport,
  log: Logger,
  commonSourceId: string | null,
): Promise<void> {
  const staleIds = new Set(stale.map((document) => document.id));

  for (const document of stale) {
    await client.delete(document.id);
    report.pruned += 1;
    report.prunedIds.push(document.id);
    log(`pruned ${document.externalDocumentId ?? document.id}`);
  }

  // Remove the now-empty legacy per-page sources, but only when the listing proves
  // every document under that source is one we just pruned. The backend source
  // delete cascades to ALL documents under the source, so deleting a source that
  // also holds a user/API document (one that happens to share an old importer
  // source URL) would silently destroy content the importer does not own.
  for (const sourceId of deletableLegacySources(existing, staleIds, commonSourceId)) {
    await client.deleteSource(sourceId);
    report.prunedSourceIds.push(sourceId);
    log(`pruned source ${sourceId}`);
  }
}

/**
 * Legacy per-page rows can share the same externalDocumentId as the new common
 * source rows. Do not infer the common source from list order; only the id
 * returned by the upsert is authoritative.
 */
function resolveCommonSourceId(
  existing: ExistingDocument[],
  firstDocumentId: string | null,
): string | null {
  if (firstDocumentId === null) {
    return null;
  }
  const created = existing.find((candidate) => candidate.id === firstDocumentId);
  if (created?.sourceId) {
    return created.sourceId;
  }
  return null;
}

/**
 * Legacy per-page sources that are safe to delete: every document the listing shows
 * under the source is in the stale set we just pruned, so the cascading source delete
 * cannot remove a document the importer does not own. A source still holding any
 * non-stale (e.g. user-created) document is left in place.
 */
function deletableLegacySources(
  existing: ExistingDocument[],
  staleIds: Set<string>,
  commonSourceId: string | null,
): string[] {
  const candidates = new Set<string>();
  for (const document of existing) {
    if (staleIds.has(document.id) && isDeletableSourceCandidate(document.sourceId, commonSourceId)) {
      candidates.add(document.sourceId);
    }
  }
  return [...candidates].filter((sourceId) =>
    existing.every((document) => document.sourceId !== sourceId || staleIds.has(document.id)),
  );
}

function isDeletableSourceCandidate(sourceId: string | null, commonSourceId: string | null): sourceId is string {
  return sourceId !== null && sourceId !== MANUAL_SOURCE_ID && (commonSourceId === null || sourceId !== commonSourceId);
}
