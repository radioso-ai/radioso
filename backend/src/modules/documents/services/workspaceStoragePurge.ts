import { z } from "zod";

import type { AuditPort } from "../../audit/contracts/index.js";
import type {
  DocumentStorageDeleteInput,
  DocumentStorageInventoryPort,
  DocumentStorageOwnersPort,
  DocumentStoragePort,
} from "../contracts/storage.js";
import {
  backgroundJobHandler,
  backgroundJobRequest,
  defineBackgroundJob,
  type BackgroundJobHandlerRegistration,
  type BackgroundJobQueue,
  type BackgroundJobRequest,
} from "../../../shared/background-jobs/index.js";
import type { Db } from "../../../shared/infra/kysely/types.js";
import { errorClassOf } from "../../../shared/observability/errorClass.js";
import type { AppLogger } from "../../../shared/observability/logger.js";

/** Objects one listing returns, and so one batch of deletes. */
const PURGE_BATCH_SIZE = 100;
/** Batches one run deletes before handing the rest to a rerun, so a run stays well inside its deadline. */
const PURGE_BATCHES_PER_RUN = 10;
/** Deletes in flight at once within a batch. */
const DELETE_CONCURRENCY = 10;

const workspaceIdSchema = z.string().uuid();

/**
 * Deletes every object document storage holds for a workspace the database no longer has. The
 * payload names the workspace and nothing else: the store finds its objects by the workspace id,
 * so no object path, which an older layout built from the filename, is ever stored with the job.
 *
 * Level-triggered: a run deletes a bounded number of batches and, when objects remain, asks for
 * one more run of the same job. A failed delete fails the run, which retries over about a day
 * before the job is dead-lettered and reported.
 */
export const WORKSPACE_STORAGE_PURGE_JOB = defineBackgroundJob({
  kind: "documents.workspace_storage_purge",
  payload: z.object({ workspaceId: workspaceIdSchema }),
  onDuplicateKey: "rerun",
  maxAttempts: 8,
  timeoutSeconds: 120,
  leaseSeconds: 180,
  retryDelaysSeconds: [60, 300, 900, 3_600, 10_800, 21_600, 43_200],
});

/** Keyed by workspace, so a deletion, a sweep, and a rerun of one workspace share one waiting job. */
export const workspaceStoragePurgeRequest = (workspaceId: string): BackgroundJobRequest =>
  backgroundJobRequest(WORKSPACE_STORAGE_PURGE_JOB, { workspaceId }, { idempotencyKey: workspaceId });

/**
 * Hands the stored files of workspaces about to be deleted to the worker, inside the transaction
 * that deletes them: the purge commits with the deletion or not at all, and runs after the commit.
 * The caller wakes the worker once its transaction committed.
 */
export const handOffWorkspaceStoragePurges = (queue: Pick<BackgroundJobQueue, "enqueueInTransaction">) =>
  async (transaction: Db, workspaceIds: readonly string[]): Promise<void> => {
    for (const workspaceId of workspaceIds) {
      await queue.enqueueInTransaction(transaction, workspaceStoragePurgeRequest(workspaceId));
    }
  };

/** Thrown when a run's deletes failed: the job retries, and the objects already deleted stay deleted. */
class WorkspaceStoragePurgeIncompleteError extends Error {
  constructor() {
    super("Some stored objects of a deleted workspace could not be deleted");
    this.name = "WorkspaceStoragePurgeIncompleteError";
  }
}

interface WorkspaceStoragePurgeDependencies {
  storage: Pick<DocumentStoragePort, "delete"> & Pick<DocumentStorageInventoryPort, "listWorkspaceObjects">;
  owners: Pick<DocumentStorageOwnersPort, "existingWorkspaceIds">;
  queue: Pick<BackgroundJobQueue, "enqueue">;
  audit: Pick<AuditPort, "record">;
  logger: Pick<AppLogger, "info" | "warn" | "error">;
  batchSize?: number;
  batchesPerRun?: number;
}

interface PurgePass {
  deleted: number;
  failed: number;
  failureClass: string | null;
  /** Objects may remain: the pass stopped at its batch budget or its deadline. */
  more: boolean;
}

const deleteBatch = async (
  storage: WorkspaceStoragePurgeDependencies["storage"],
  objects: readonly DocumentStorageDeleteInput[],
): Promise<Pick<PurgePass, "deleted" | "failed" | "failureClass">> => {
  let deleted = 0;
  let failed = 0;
  let failureClass: string | null = null;
  for (let start = 0; start < objects.length; start += DELETE_CONCURRENCY) {
    const outcomes = await Promise.allSettled(
      objects.slice(start, start + DELETE_CONCURRENCY).map((object) => storage.delete(object)),
    );
    for (const outcome of outcomes) {
      if (outcome.status === "fulfilled") {
        deleted += 1;
      } else {
        failed += 1;
        failureClass ??= errorClassOf(outcome.reason);
      }
    }
  }
  return { deleted, failed, failureClass };
};

const runPurgePass = async (
  deps: WorkspaceStoragePurgeDependencies,
  workspaceId: string,
  signal: AbortSignal,
): Promise<PurgePass> => {
  const batchSize = deps.batchSize ?? PURGE_BATCH_SIZE;
  let deleted = 0;
  for (let batch = 0; batch < (deps.batchesPerRun ?? PURGE_BATCHES_PER_RUN); batch += 1) {
    if (signal.aborted) return { deleted, failed: 0, failureClass: null, more: true };
    const objects = await deps.storage.listWorkspaceObjects({ workspaceId, limit: batchSize });
    const outcome = await deleteBatch(deps.storage, objects);
    deleted += outcome.deleted;
    if (outcome.failed > 0) return { deleted, failed: outcome.failed, failureClass: outcome.failureClass, more: true };
    if (objects.length < batchSize) return { deleted, failed: 0, failureClass: null, more: false };
  }
  return { deleted, failed: 0, failureClass: null, more: true };
};

const WORKSPACE_EXISTS = { skipped: "workspace_exists" } as const;

/**
 * Runs one purge pass for a deleted workspace. A workspace that still exists keeps its files: the
 * job only ever empties the store of a workspace the database no longer has.
 */
export const workspaceStoragePurgeHandler = (
  deps: WorkspaceStoragePurgeDependencies,
): BackgroundJobHandlerRegistration =>
  backgroundJobHandler(WORKSPACE_STORAGE_PURGE_JOB, async ({ workspaceId }, { signal }) => {
    if ((await deps.owners.existingWorkspaceIds([workspaceId])).has(workspaceId)) {
      deps.logger.warn({ workspaceId }, "Stored files kept: their workspace still exists");
      return WORKSPACE_EXISTS;
    }

    const pass = await runPurgePass(deps, workspaceId, signal);
    const fields = {
      workspaceId,
      deletedObjectCount: pass.deleted,
      failedObjectCount: pass.failed,
      objectsRemain: pass.more,
      ...(pass.failureClass ? { errorClass: pass.failureClass } : {}),
    };
    if (pass.failed > 0) {
      deps.logger.warn(fields, "Deleted workspace's stored files partly deleted; the purge retries");
    } else {
      deps.logger.info(fields, "Deleted workspace's stored files deleted");
    }
    if (pass.deleted > 0) await recordDeletion(deps, workspaceId, pass.deleted);

    if (pass.failed > 0) throw new WorkspaceStoragePurgeIncompleteError();
    if (pass.more) await deps.queue.enqueue(workspaceStoragePurgeRequest(workspaceId));
  });

/** The files are already gone, so a failed audit write is logged with the count rather than retried. */
const recordDeletion = async (
  deps: Pick<WorkspaceStoragePurgeDependencies, "audit" | "logger">,
  workspaceId: string,
  deletedObjectCount: number,
): Promise<void> => {
  await deps.audit.record({
    accountId: null,
    workspaceId: null,
    eventType: "workspace.stored_files.deleted",
    eventStatus: "success",
    metadata: { deletedWorkspaceId: workspaceId, deletedObjectCount, principalType: "system" },
  }).catch((error: unknown) => {
    deps.logger.error(
      { workspaceId, deletedObjectCount, errorClass: errorClassOf(error) },
      "Audit of deleted stored files failed after the files were deleted",
    );
  });
};
