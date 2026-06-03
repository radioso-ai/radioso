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
  const existing = await client.listAll();

  for (const document of desired) {
    const result = await client.create(document);
    log(`upserted ${document.externalDocumentId} (${result.status})`);
  }

  const report: SyncReport = { upserted: desired.length, pruned: 0, prunedIds: [] };
  if (!options.prune) {
    return report;
  }

  const desiredIds = new Set(desired.map((document) => document.externalDocumentId));
  const stale = existing.filter(
    (document) => inPruneScope(document, options.pruneSections) && !isDesired(document, desiredIds),
  );

  for (const document of stale) {
    await client.delete(document.id);
    report.pruned += 1;
    report.prunedIds.push(document.id);
    log(`pruned ${document.externalDocumentId ?? document.id}`);
  }

  return report;
}

function inPruneScope(document: ExistingDocument, pruneSections: Set<string>): boolean {
  const section = document.metadata?.section;
  return typeof section === "string" && pruneSections.has(section);
}

function isDesired(document: ExistingDocument, desiredIds: Set<string>): boolean {
  return document.externalDocumentId !== null && desiredIds.has(document.externalDocumentId);
}
