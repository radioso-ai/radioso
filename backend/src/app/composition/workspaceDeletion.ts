import { handOffWorkspaceStoragePurges } from "../../modules/documents/composition.js";
import type { BackgroundJobQueue } from "../../shared/background-jobs/index.js";
import type { Db } from "../../shared/infra/kysely/types.js";
import { createWorkspaceConversationDataErasure } from "./conversationErasure.js";

/** Closures, not methods: the lifecycle repository holds each one as a value. */
interface WorkspaceDeletionHooks {
  /** Runs inside the deletion's transaction, just before its workspaces go. */
  inTransaction: (trx: Db, workspaceIds: readonly string[]) => Promise<void>;
  /** Runs once the deletion committed. Never rejects. */
  afterCommit: () => Promise<void>;
}

/**
 * What deleting a workspace, or an organization with all of its workspaces, does beyond its
 * cascade. Inside the transaction: every module's eraser for the conversation content that
 * outlives the rows, then the hand-off of each workspace's stored files to the worker, which
 * commits with the deletion or not at all. Once it committed: a wake, so the worker deletes the
 * files without waiting for the recovery sweep.
 */
export const createWorkspaceDeletionHooks = (deps: {
  queue: Pick<BackgroundJobQueue, "enqueueInTransaction" | "wake">;
}): WorkspaceDeletionHooks => {
  const eraseConversationData = createWorkspaceConversationDataErasure();
  const handOffStoredFiles = handOffWorkspaceStoragePurges(deps.queue);
  return {
    inTransaction: async (trx, workspaceIds) => {
      await eraseConversationData(trx, workspaceIds);
      await handOffStoredFiles(trx, workspaceIds);
    },
    afterCommit: () => deps.queue.wake(),
  };
};
