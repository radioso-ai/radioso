import type { Kysely } from "kysely";

import { ActionRequestRepository } from "../../db/repositories/actionRequestRepository.js";
import { ConversationOwnershipRepository } from "../../db/repositories/conversationOwnershipRepository.js";
import type { ActionDrainDispatcherPort } from "../../modules/chat/services/actions/actionDrainDispatcher.js";
import type { OwnershipTransferUnitOfWork } from "../../modules/handoff/public.js";
import type { DB } from "../../shared/infra/kysely/types.js";
import type { AppLogger } from "../../shared/observability/logger.js";

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
}): OwnershipTransferUnitOfWork => ({
  async run(work) {
    let queued = false;
    const result = await deps.db.transaction().execute(async (trx) => {
      const outbox = new ActionRequestRepository(trx);
      return work({
        ownership: new ConversationOwnershipRepository(trx),
        outbox: {
          enqueue: async (request) => {
            const enqueued = await outbox.enqueue(request);
            queued = true;
            return enqueued;
          },
        },
      });
    });
    if (queued) {
      try {
        await deps.actionDrain.requestDrain();
      } catch (error) {
        deps.logger.warn(
          { event: "conversation_transfer_notice_drain_push_failed", errorClass: error instanceof Error ? error.name : typeof error },
          "Action outbox drain push failed; the interval poller or recovery sweep will pick this up",
        );
      }
    }
    return result;
  },
});
