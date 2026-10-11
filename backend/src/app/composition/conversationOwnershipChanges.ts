import type { Kysely } from "kysely";

import { ActionRequestRepository } from "../../db/repositories/actionRequestRepository.js";
import { ConversationOwnershipRepository } from "../../db/repositories/conversationOwnershipRepository.js";
import { ConversationRepository } from "../../db/repositories/conversationRepository.js";
import { HeldReplyRepository } from "../../db/repositories/heldReplyRepository.js";
import type { ActionDrainDispatcherPort } from "../../modules/chat/composition.js";
import type { ConversationActivityRecorder } from "../../modules/conversationActivity/contracts/index.js";
import type { OwnershipChangeUnitOfWork } from "../../modules/handoff/public.js";
import type { ErrorReporter } from "../../shared/errors/errorReporter.js";
import type { DB } from "../../shared/infra/kysely/types.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import { pushActionDrainAfterCommit, type QueuedOutboxRow } from "./actionDrainAfterCommit.js";
import { runTransactionWithDeadlockRetry } from "./conversationLockOrder.js";

/**
 * Runs an ownership change — a claim, a transfer, a hand-back — with the activity it records, the
 * notice a transfer queues and the held replies a claim supersedes in one Postgres transaction, so
 * a failed activity, outbox or held-reply write rolls the change back instead of leaving a change
 * nobody can trace, a recipient who is never told, or a draft that outlives the claim that replaced
 * it. The drain push goes out only after commit, when there is a row to drain; it is best-effort,
 * since the interval poller and the recovery sweep still pick the row up.
 *
 * A claim locks the conversation before it may create the ownership row, the conversation lock
 * protocol's order (`conversationLockOrder.ts`); a deadlock victim's whole transaction runs again,
 * a bounded number of times.
 */
export const createPostgresOwnershipChangeUnitOfWork = (deps: {
  db: Kysely<DB>;
  activity: ConversationActivityRecorder;
  actionDrain: ActionDrainDispatcherPort;
  logger: Pick<AppLogger, "warn">;
  errorReporter?: Pick<ErrorReporter, "report">;
}): OwnershipChangeUnitOfWork => ({
  async run(work) {
    let queued: QueuedOutboxRow | null = null;
    const result = await runTransactionWithDeadlockRetry(deps.db, (trx) => {
      // Reset per attempt: an aborted attempt queued nothing.
      queued = null;
      const outbox = new ActionRequestRepository(trx);
      return work({
        conversations: new ConversationRepository(trx),
        ownership: new ConversationOwnershipRepository(trx),
        outbox: {
          enqueue: async (request) => {
            const enqueued = await outbox.enqueue(request);
            queued = request;
            return enqueued;
          },
        },
        activity: { record: (event) => deps.activity.record(trx, event) },
        heldReplies: new HeldReplyRepository(trx),
      });
    }, { unit: "conversation_ownership_change", logger: deps.logger });
    if (queued) {
      await pushActionDrainAfterCommit(deps, "conversation_transfer_notice_drain_push_failed", queued);
    }
    return result;
  },
});
