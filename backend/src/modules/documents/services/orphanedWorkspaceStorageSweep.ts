import { createHash } from "node:crypto";

import { z } from "zod";

import type { DocumentStorageInventoryPort, DocumentStorageOwnersPort } from "../contracts/storage.js";
import { workspaceStoragePurgeRequest } from "./workspaceStoragePurge.js";
import {
  backgroundJobHandler,
  backgroundJobRequest,
  defineBackgroundJob,
  type BackgroundJobHandlerRegistration,
  type BackgroundJobQueue,
  type BackgroundJobRequest,
} from "../../../shared/background-jobs/index.js";
import type { AppLogger } from "../../../shared/observability/logger.js";

/** Workspaces one listing page returns. */
const SWEEP_PAGE_SIZE = 100;
/** Pages one run reads before continuing in a new job; each orphan candidate is summarized in full. */
const SWEEP_PAGES_PER_RUN = 2;
/** Workspaces holding uploaded files that the ownership check looks for in the store. */
const OWNERSHIP_SAMPLE_SIZE = 20;
/** A prefix written to more recently than this is in use somewhere, and is kept. */
const RECENT_OBJECT_WINDOW_MS = 24 * 60 * 60 * 1_000;
/** The only form a workspace id takes in a storage path: Postgres prints UUIDs in lowercase. */
const CANONICAL_WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The idempotency key of a sweep's first page. */
const SWEEP_START_KEY = "start";

/**
 * Finds the workspaces document storage holds files for that the database no longer has, and
 * queues a purge for each: the files of workspaces and organizations deleted before a deletion
 * handed its files to the worker. An operator queues it, after a dry run, with the
 * `workspaceStorageSweep` entrypoint (`src/workspaceStorageSweep.ts`); nothing queues it on its own.
 *
 * The sweep cannot tell a workspace this database deleted from one another database owns. Its
 * ownership check proves only that the store holds some of this database's files, so a store
 * shared with another deployment passes it, and that deployment's workspaces read as orphaned.
 * Each deployment needs its own bucket or folder. A prefix written to in the last 24 hours is kept
 * as in use, and a prefix that is not a canonical workspace id is never touched.
 */
export const ORPHANED_WORKSPACE_STORAGE_SWEEP_JOB = defineBackgroundJob({
  kind: "documents.orphaned_workspace_storage_sweep",
  payload: z.object({ cursor: z.string().min(1).max(4_096).nullable() }),
  onDuplicateKey: "ignore",
  maxAttempts: 5,
  timeoutSeconds: 120,
  leaseSeconds: 180,
  retryDelaysSeconds: [300, 900, 3_600],
});

/** Starts the sweep (`cursor` null) or continues it from a page cursor the store returned. */
export const orphanedWorkspaceStorageSweepRequest = (cursor: string | null): BackgroundJobRequest =>
  backgroundJobRequest(ORPHANED_WORKSPACE_STORAGE_SWEEP_JOB, { cursor }, {
    // A cursor is opaque and can be long; its digest names the page within the key's length limit.
    idempotencyKey: cursor === null ? SWEEP_START_KEY : `after:${createHash("sha256").update(cursor).digest("hex")}`,
  });

export const isCanonicalWorkspaceId = (value: string): boolean => CANONICAL_WORKSPACE_ID.test(value);

/** Whether the store holds this database's files, which a sweep requires before it queues anything. */
export type DocumentStorageOwnershipCheck = "verified" | "no_uploaded_files" | "store_mismatch";

interface SweepDependencies {
  storage: Pick<DocumentStorageInventoryPort, "listStoredWorkspaces" | "listWorkspaceObjects" | "summarizeWorkspaceObjects">;
  owners: DocumentStorageOwnersPort;
  now?: () => Date;
  pageSize?: number;
}

const checkDocumentStorageOwnership = async (
  deps: Pick<SweepDependencies, "storage" | "owners">,
): Promise<DocumentStorageOwnershipCheck> => {
  const known = await deps.owners.workspacesWithUploadedFiles(OWNERSHIP_SAMPLE_SIZE);
  if (known.length === 0) return "no_uploaded_files";
  for (const workspaceId of known) {
    if ((await deps.storage.listWorkspaceObjects({ workspaceId, limit: 1 })).length > 0) return "verified";
  }
  return "store_mismatch";
};

interface StoredWorkspaceClassification {
  orphans: Array<{ workspaceId: string; objectCount: number }>;
  liveWorkspaceCount: number;
  recentObjectCount: number;
  nonCanonicalPrefixCount: number;
}

/** Sorts one page of stored workspaces into orphans and the reasons the rest are kept. */
const classifyStoredWorkspaces = async (
  deps: SweepDependencies,
  workspaceIds: readonly string[],
): Promise<StoredWorkspaceClassification> => {
  const canonical = workspaceIds.filter(isCanonicalWorkspaceId);
  const existing = await deps.owners.existingWorkspaceIds(canonical);
  const recentSince = (deps.now ?? (() => new Date()))().getTime() - RECENT_OBJECT_WINDOW_MS;
  const classification: StoredWorkspaceClassification = {
    orphans: [],
    liveWorkspaceCount: existing.size,
    recentObjectCount: 0,
    nonCanonicalPrefixCount: workspaceIds.length - canonical.length,
  };
  for (const workspaceId of canonical) {
    if (existing.has(workspaceId)) continue;
    const summary = await deps.storage.summarizeWorkspaceObjects({ workspaceId });
    if (summary.newestObjectAt !== null && summary.newestObjectAt.getTime() > recentSince) {
      classification.recentObjectCount += 1;
    } else {
      classification.orphans.push({ workspaceId, objectCount: summary.objectCount });
    }
  }
  return classification;
};

export interface OrphanedWorkspaceStorageReport {
  ownership: DocumentStorageOwnershipCheck;
  scannedPrefixCount: number;
  orphanedWorkspaceCount: number;
  orphanedObjectCount: number;
  liveWorkspaceCount: number;
  recentObjectCount: number;
  nonCanonicalPrefixCount: number;
}

/**
 * What a sweep would queue right now, by count, reading the whole store and deleting nothing.
 * Its reads grow with what the store holds, so it belongs to an operator's dry run.
 */
export const reportOrphanedWorkspaceStorage = async (deps: SweepDependencies): Promise<OrphanedWorkspaceStorageReport> => {
  const report: OrphanedWorkspaceStorageReport = {
    ownership: await checkDocumentStorageOwnership(deps),
    scannedPrefixCount: 0,
    orphanedWorkspaceCount: 0,
    orphanedObjectCount: 0,
    liveWorkspaceCount: 0,
    recentObjectCount: 0,
    nonCanonicalPrefixCount: 0,
  };
  let cursor: string | null = null;
  do {
    const listing = await deps.storage.listStoredWorkspaces({ cursor, limit: deps.pageSize ?? SWEEP_PAGE_SIZE });
    const classification = await classifyStoredWorkspaces(deps, listing.workspaceIds);
    report.scannedPrefixCount += listing.workspaceIds.length;
    report.orphanedWorkspaceCount += classification.orphans.length;
    report.orphanedObjectCount += classification.orphans.reduce((sum, orphan) => sum + orphan.objectCount, 0);
    report.liveWorkspaceCount += classification.liveWorkspaceCount;
    report.recentObjectCount += classification.recentObjectCount;
    report.nonCanonicalPrefixCount += classification.nonCanonicalPrefixCount;
    cursor = listing.nextCursor;
  } while (cursor !== null);
  return report;
};

interface OrphanedWorkspaceStorageSweepDependencies extends SweepDependencies {
  queue: Pick<BackgroundJobQueue, "enqueue">;
  logger: Pick<AppLogger, "info" | "warn">;
  pagesPerRun?: number;
}

const STORE_NOT_VERIFIED = { skipped: "store_not_verified" } as const;

export const orphanedWorkspaceStorageSweepHandler = (
  deps: OrphanedWorkspaceStorageSweepDependencies,
): BackgroundJobHandlerRegistration =>
  backgroundJobHandler(ORPHANED_WORKSPACE_STORAGE_SWEEP_JOB, async (payload, { signal }) => {
    if (payload.cursor === null) {
      const ownership = await checkDocumentStorageOwnership(deps);
      if (ownership === "no_uploaded_files") {
        deps.logger.info({}, "Orphaned stored-file sweep had nothing to check the store against: no uploaded file recorded");
        return STORE_NOT_VERIFIED;
      }
      if (ownership === "store_mismatch") {
        deps.logger.warn({}, "Orphaned stored-file sweep deleted nothing: document storage holds no file this database records");
        return STORE_NOT_VERIFIED;
      }
    }

    let cursor = payload.cursor;
    let complete = false;
    const counts = { scannedPrefixCount: 0, orphanedWorkspaceCount: 0, liveWorkspaceCount: 0, recentObjectCount: 0, nonCanonicalPrefixCount: 0 };
    for (let page = 0; page < (deps.pagesPerRun ?? SWEEP_PAGES_PER_RUN) && !signal.aborted; page += 1) {
      const listing = await deps.storage.listStoredWorkspaces({ cursor, limit: deps.pageSize ?? SWEEP_PAGE_SIZE });
      const classification = await classifyStoredWorkspaces(deps, listing.workspaceIds);
      for (const orphan of classification.orphans) {
        await deps.queue.enqueue(workspaceStoragePurgeRequest(orphan.workspaceId));
      }
      counts.scannedPrefixCount += listing.workspaceIds.length;
      counts.orphanedWorkspaceCount += classification.orphans.length;
      counts.liveWorkspaceCount += classification.liveWorkspaceCount;
      counts.recentObjectCount += classification.recentObjectCount;
      counts.nonCanonicalPrefixCount += classification.nonCanonicalPrefixCount;
      if (listing.nextCursor === null) {
        complete = true;
        break;
      }
      cursor = listing.nextCursor;
    }
    if (!complete) await deps.queue.enqueue(orphanedWorkspaceStorageSweepRequest(cursor));

    deps.logger.info({ ...counts, sweepComplete: complete }, "Orphaned stored-file sweep queued purges");
  });
