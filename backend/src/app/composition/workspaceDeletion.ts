import { handOffWorkspaceStoragePurges } from "../../modules/documents/composition.js";
import type { BackgroundJobQueue } from "../../shared/background-jobs/index.js";
import type { VendorHeldConversationDataEraser } from "../../shared/domain/conversationDataErasure.js";
import type { Db } from "../../shared/infra/kysely/types.js";
import { createWorkspaceConversationDataErasure } from "./conversationErasure.js";

/** Closures, not methods: the lifecycle repository holds each one as a value. */
interface WorkspaceDeletionHooks {
  /** Runs inside the deletion's transaction, just before its workspaces go. */
  inTransaction: (trx: Db, workspaceIds: readonly string[], deletion: { accountId: string }) => Promise<void>;
  /** Runs once the deletion committed. Never rejects. */
  afterCommit: () => Promise<void>;
}

/**
 * What deleting a workspace, or an organization with all of its workspaces, does beyond its
 * cascade. Inside the transaction: the hand-off of what vendors hold for the workspaces'
 * conversations (each call recording, with the workspace's vendor key sealed beside it) to a
 * backlog that outlives the cascade, then every module's eraser for the conversation content that
 * outlives the rows, then the hand-off of each workspace's stored files to the worker. Each
 * hand-off commits with the deletion or not at all. Once it committed: one wake, so the worker
 * starts on both without waiting for the recovery sweep; it is also the vendor hand-off's own
 * after-commit step, which is a wake of the same queue.
 */
export const createWorkspaceDeletionHooks = (deps: {
  queue: Pick<BackgroundJobQueue, "enqueueInTransaction" | "wake">;
  /** What vendors hold, bound to the deletion's transaction. */
  vendorHeld: (trx: Db) => VendorHeldConversationDataEraser;
}): WorkspaceDeletionHooks => {
  const eraseConversationData = createWorkspaceConversationDataErasure();
  const handOffStoredFiles = handOffWorkspaceStoragePurges(deps.queue);
  return {
    inTransaction: async (trx, workspaceIds, { accountId }) => {
      // First: the voice eraser among the others removes the rows that say where each recording is.
      await deps.vendorHeld(trx).handOff({
        accountId,
        scopes: workspaceIds.map((workspaceId) => ({ kind: "workspace", workspaceId })),
      });
      await eraseConversationData(trx, workspaceIds);
      await handOffStoredFiles(trx, workspaceIds);
    },
    afterCommit: () => deps.queue.wake(),
  };
};
