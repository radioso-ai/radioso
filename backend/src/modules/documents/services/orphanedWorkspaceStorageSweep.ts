import { createHash } from "node:crypto";

import { z } from "zod";

import type { DocumentStorageInventoryPort, DocumentStorageOwnersPort } from "../contracts/storage.js";
import { workspaceIdSchema, workspaceStoragePurgeRequest } from "./workspaceStoragePurge.js";
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
const SWEEP_PAGE_SIZE = 200;
/** Pages one run reads before continuing in a new job. */
const SWEEP_PAGES_PER_RUN = 5;
/** Workspaces holding uploaded files that the ownership check looks for in the store. */
const OWNERSHIP_SAMPLE_SIZE = 20;

/** The idempotency key of a sweep's first page. Migration 240 queues the one-time sweep under it. */
const SWEEP_START_KEY = "start";

/**
 * Finds the workspaces document storage holds files for that the database no longer has, and
 * queues a purge for each: the files of workspaces and organizations deleted before a deletion
 * handed its files to the worker. Migration 240 queues it once per database.
 *
 * Before it deletes anything the sweep checks that the store is this database's: it must find the
 * files of at least one workspace whose documents, by this database's records, have an uploaded
 * file. A store shared with, or belonging to, another database fails that check and keeps
 * everything.
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

interface OrphanedWorkspaceStorageSweepDependencies {
  storage: DocumentStorageInventoryPort;
  owners: DocumentStorageOwnersPort;
  queue: Pick<BackgroundJobQueue, "enqueue">;
  logger: Pick<AppLogger, "info" | "warn">;
  pageSize?: number;
  pagesPerRun?: number;
}

const storeHoldsThisDatabasesFiles = async (deps: OrphanedWorkspaceStorageSweepDependencies): Promise<boolean> => {
  for (const workspaceId of await deps.owners.workspacesWithUploadedFiles(OWNERSHIP_SAMPLE_SIZE)) {
    if ((await deps.storage.listWorkspaceObjects({ workspaceId, limit: 1 })).length > 0) return true;
  }
  return false;
};

const STORE_NOT_VERIFIED = { skipped: "store_not_verified" } as const;

export const orphanedWorkspaceStorageSweepHandler = (
  deps: OrphanedWorkspaceStorageSweepDependencies,
): BackgroundJobHandlerRegistration =>
  backgroundJobHandler(ORPHANED_WORKSPACE_STORAGE_SWEEP_JOB, async (payload, { signal }) => {
    if (payload.cursor === null && !(await storeHoldsThisDatabasesFiles(deps))) {
      deps.logger.warn(
        {},
        "Orphaned stored-file sweep deleted nothing: document storage holds no file this database records",
      );
      return STORE_NOT_VERIFIED;
    }

    let cursor = payload.cursor;
    let complete = false;
    let scannedWorkspaceCount = 0;
    let orphanedWorkspaceCount = 0;
    for (let page = 0; page < (deps.pagesPerRun ?? SWEEP_PAGES_PER_RUN) && !signal.aborted; page += 1) {
      const listing = await deps.storage.listStoredWorkspaces({ cursor, limit: deps.pageSize ?? SWEEP_PAGE_SIZE });
      // A prefix that is not a workspace id is nothing this database could own.
      const candidates = listing.workspaceIds.filter((workspaceId) => workspaceIdSchema.safeParse(workspaceId).success);
      const existing = await deps.owners.existingWorkspaceIds(candidates);
      for (const workspaceId of candidates) {
        if (existing.has(workspaceId)) continue;
        await deps.queue.enqueue(workspaceStoragePurgeRequest(workspaceId));
        orphanedWorkspaceCount += 1;
      }
      scannedWorkspaceCount += listing.workspaceIds.length;
      if (listing.nextCursor === null) {
        complete = true;
        break;
      }
      cursor = listing.nextCursor;
    }
    if (!complete) await deps.queue.enqueue(orphanedWorkspaceStorageSweepRequest(cursor));

    deps.logger.info(
      { scannedWorkspaceCount, orphanedWorkspaceCount, sweepComplete: complete },
      "Orphaned stored-file sweep queued purges",
    );
  });
