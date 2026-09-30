import type { Kysely } from "kysely";

import { ActionRequestRepository } from "../../db/repositories/actionRequestRepository.js";
import { ConversationOwnershipRepository } from "../../db/repositories/conversationOwnershipRepository.js";
import type { ActionDrainDispatcherPort } from "../../modules/chat/composition.js";
import type { OwnershipTransferUnitOfWork } from "../../modules/handoff/public.js";
import type { ErrorReporter } from "../../shared/errors/errorReporter.js";
import type { DB } from "../../shared/infra/kysely/types.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import { pushActionDrainAfterCommit, type QueuedOutboxRow } from "./actionDrainAfterCommit.js";

/**
 * Runs a transfer and the notice it queues in one Postgres transaction, so a failed outbox write
 * rolls the transfer back instead of leaving a recipient who is never told. The drain push goes
 * out only after commit, when there is a row to drain; it is best-effort, since the interval
 * poller and the recovery sweep still pick the row up.
 */
export const createPostgresOwnershipTransferUnitOfWork = (deps: {
  db: Kysely<DB>;
  actionDrain: ActionDrainDispatcherPort;
  logger: Pick<AppLogger, "warn">;
  errorReporter?: Pick<ErrorReporter, "report">;
}): OwnershipTransferUnitOfWork => ({
  async run(work) {
    let queued: QueuedOutboxRow | null = null;
    const result = await deps.db.transaction().execute(async (trx) => {
      const outbox = new ActionRequestRepository(trx);
      return work({
        ownership: new ConversationOwnershipRepository(trx),
        outbox: {
          enqueue: async (request) => {
            const enqueued = await outbox.enqueue(request);
            queued = request;
            return enqueued;
          },
        },
      });
    });
    if (queued) {
      await pushActionDrainAfterCommit(deps, "conversation_transfer_notice_drain_push_failed", queued);
    }
    return result;
  },
});
