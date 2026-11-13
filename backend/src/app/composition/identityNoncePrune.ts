import type { IdentityNonceRepositoryPort } from "../../db/repositories/identityNonceRepository.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type { ApplicationPeriodicTaskHandle } from "./applicationModule.js";

/** The registration id the worker task route runs it by, and the Cloud Scheduler job's name. */
const IDENTITY_NONCE_PRUNE_TASK_ID = "identity-nonce-prune";
/** Every 15 minutes, matching `identity_nonce_prune_schedule` in Terraform. */
const IDENTITY_NONCE_PRUNE_INTERVAL_MS = 15 * 60 * 1_000;
/** Rows one delete removes, and the most deletes one run makes; a backlog drains over the next runs. */
export const IDENTITY_NONCE_PRUNE_BATCH_SIZE = 1_000;
export const IDENTITY_NONCE_PRUNE_MAX_BATCHES_PER_RUN = 20;

/**
 * Deletes the single-use nonces a verified visitor identity left behind once their window has
 * passed. A nonce row exists to refuse a replay of its token, and the verifier already refuses a
 * token outside its acceptance window, so a row past its `expires_at` (the token's issue time plus
 * that window, as the verifier recorded it) can never again decide anything.
 */
export const identityNoncePrunePeriodicTask = (deps: {
  nonces: Pick<IdentityNonceRepositoryPort, "deleteExpired">;
  logger: Pick<AppLogger, "info">;
  clock?: () => Date;
}): { id: string; intervalMs: number; handle: ApplicationPeriodicTaskHandle } => ({
  id: IDENTITY_NONCE_PRUNE_TASK_ID,
  intervalMs: IDENTITY_NONCE_PRUNE_INTERVAL_MS,
  handle: {
    run: async () => {
      const now = (deps.clock ?? (() => new Date()))();
      let removed = 0;
      for (let batch = 0; batch < IDENTITY_NONCE_PRUNE_MAX_BATCHES_PER_RUN; batch += 1) {
        const deleted = await deps.nonces.deleteExpired(now, IDENTITY_NONCE_PRUNE_BATCH_SIZE);
        removed += deleted;
        if (deleted < IDENTITY_NONCE_PRUNE_BATCH_SIZE) break;
      }
      if (removed > 0) {
        deps.logger.info({ removed }, "Pruned expired visitor identity nonces");
      }
    },
  },
});
