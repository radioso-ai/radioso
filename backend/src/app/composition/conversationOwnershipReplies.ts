import type { Kysely } from "kysely";

import { ActionRequestRepository } from "../../db/repositories/actionRequestRepository.js";
import { ConversationOwnershipRepository } from "../../db/repositories/conversationOwnershipRepository.js";
import { ConversationRepository } from "../../db/repositories/conversationRepository.js";
import { HeldReplyRepository } from "../../db/repositories/heldReplyRepository.js";
import { MessageRepository } from "../../db/repositories/messageRepository.js";
import type { ActionDrainDispatcherPort } from "../../modules/chat/composition.js";
import type { ConversationActivityRecorder } from "../../modules/conversationActivity/contracts/index.js";
import type { OwnershipReplyUnitOfWork } from "../../modules/handoff/public.js";
import type { ErrorReporter } from "../../shared/errors/errorReporter.js";
import type { DB } from "../../shared/infra/kysely/types.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import { pushActionDrainAfterCommit, type QueuedOutboxRow } from "./actionDrainAfterCommit.js";

/**
 * Runs a teammate's reply in one Postgres transaction: the conversation and ownership rows are
 * locked before the ownership is checked, so a transfer or hand-back cannot commit between the
 * check and the message insert; and the reply's channel delivery is queued on the action outbox in
 * the same transaction, so a reply commits with its delivery or not at all. A claim the reply makes
 * records its activity, and the held replies the reply replaces are superseded, in the same
 * transaction too, in the conversation lock protocol's order (`conversationLockOrder.ts`). The drain
 * push goes out only after commit, when a delivery was queued, and is best-effort.
 */
export const createPostgresOwnershipReplyUnitOfWork = (deps: {
  db: Kysely<DB>;
  activity: ConversationActivityRecorder;
  actionDrain: ActionDrainDispatcherPort;
  logger: Pick<AppLogger, "warn">;
  errorReporter?: Pick<ErrorReporter, "report">;
}): OwnershipReplyUnitOfWork => ({
  async run(work) {
    let queued: QueuedOutboxRow | null = null;
    const result = await deps.db.transaction().execute((trx) => {
      const conversations = new ConversationRepository(trx);
      const outbox = new ActionRequestRepository(trx);
      return work({
        conversations,
        ownership: new ConversationOwnershipRepository(trx),
        reply: {
          messages: new MessageRepository(trx),
          conversations,
          outbox: {
            enqueue: async (request) => {
              const enqueued = await outbox.enqueue(request);
              queued = request;
              return enqueued;
            },
          },
        },
        activity: { record: (event) => deps.activity.record(trx, event) },
        heldReplies: new HeldReplyRepository(trx),
      });
    });
    if (queued) {
      await pushActionDrainAfterCommit(deps, "hitl_reply_delivery_drain_push_failed", queued);
    }
    return result;
  },
});
