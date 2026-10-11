import type { Kysely } from "kysely";

import { ActionRequestRepository } from "../../db/repositories/actionRequestRepository.js";
import { ConversationOwnershipRepository } from "../../db/repositories/conversationOwnershipRepository.js";
import { ConversationRepository } from "../../db/repositories/conversationRepository.js";
import { DirectiveStateRepository } from "../../db/repositories/directiveStateRepository.js";
import { HeldReplyRepository } from "../../db/repositories/heldReplyRepository.js";
import { MessageRepository } from "../../db/repositories/messageRepository.js";
import { reviewedDraftWriter, type ActionDrainDispatcherPort } from "../../modules/chat/composition.js";
import type { ConversationActivityRecorder } from "../../modules/conversationActivity/contracts/index.js";
import type { HeldReplyChannelScope, HeldReplyUnitOfWork } from "../../modules/handoff/public.js";
import type { ErrorReporter } from "../../shared/errors/errorReporter.js";
import type { DB, Db } from "../../shared/infra/kysely/types.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import { pushActionDrainAfterCommit, type QueuedOutboxRow } from "./actionDrainAfterCommit.js";
import { runTransactionWithDeadlockRetry } from "./conversationLockOrder.js";

/** A producing channel's side of held-reply transactions: the policy-ref prefix it owns, and its scope bound to one. */
export interface HeldReplyChannelRegistration {
  policyRefPrefix: string;
  bind(trx: Db): HeldReplyChannelScope;
}

/** Finds the registration a policy ref belongs to by its prefix; refuses prefixes that would let a ref name two channels. */
const channelRegistry = (
  registrations: readonly HeldReplyChannelRegistration[],
): ((policyRef: string) => HeldReplyChannelRegistration | null) => {
  for (const registration of registrations) {
    const overlapping = registrations.find((other) =>
      other !== registration && other.policyRefPrefix.startsWith(registration.policyRefPrefix));
    if (registration.policyRefPrefix.length === 0 || overlapping) {
      throw new Error(`Held-reply channel prefixes overlap: "${registration.policyRefPrefix}"`);
    }
  }
  return (policyRef) => registrations.find((registration) => policyRef.startsWith(registration.policyRefPrefix)) ?? null;
};

/**
 * Runs a held-reply command — hold, queue an automatic send, materialize it, release, discard — in
 * one Postgres transaction, binding to it the conversation and ownership locks, the held replies,
 * the producing channel's scope (found by the draft's policy-ref prefix, bound once per
 * transaction), the message a release or materialization writes with its delivery on the action
 * outbox, the directive firing memory advance an unchanged draft deferred, and the activity. The lock order is the conversation lock protocol's
 * (`conversationLockOrder.ts`), as the held-reply service takes it: conversation, ownership, the
 * channel's policy, the conditional held-reply write, the message, then the delivery — a queued
 * send's on the outbox, a materialized one's as the channel's send record, in the same transaction.
 * A policy change meeting a draft born after it locked its conversations can make Postgres abort
 * the command as a deadlock victim; its whole transaction then runs again, a bounded number of
 * times. The drain push goes out only after commit, when a delivery was queued, and is best-effort.
 */
export const createPostgresHeldReplyUnitOfWork = (deps: {
  db: Kysely<DB>;
  channels: readonly HeldReplyChannelRegistration[];
  activity: ConversationActivityRecorder;
  actionDrain: ActionDrainDispatcherPort;
  logger: Pick<AppLogger, "warn">;
  errorReporter?: Pick<ErrorReporter, "report">;
}): HeldReplyUnitOfWork => {
  const registrationFor = channelRegistry(deps.channels);
  return {
    async run(work) {
      let queued: QueuedOutboxRow | null = null;
      const result = await runTransactionWithDeadlockRetry(deps.db, (trx) => {
        // An aborted attempt queued nothing.
        queued = null;
        const conversations = new ConversationRepository(trx);
        const messages = new MessageRepository(trx);
        const outbox = new ActionRequestRepository(trx);
        const bound = new Map<HeldReplyChannelRegistration, HeldReplyChannelScope>();
        return work({
          conversations,
          ownership: new ConversationOwnershipRepository(trx),
          channelFor: (policyRef) => {
            const registration = registrationFor(policyRef);
            if (!registration) {
              return null;
            }
            const scope = bound.get(registration) ?? registration.bind(trx);
            bound.set(registration, scope);
            return scope;
          },
          heldReplies: new HeldReplyRepository(trx),
          reply: {
            messages,
            conversations,
            outbox: {
              enqueue: async (request) => {
                const enqueued = await outbox.enqueue(request);
                queued = request;
                return enqueued;
              },
            },
          },
          drafts: reviewedDraftWriter({ messages, directiveStates: new DirectiveStateRepository(trx) }),
          activity: { record: (event) => deps.activity.record(trx, event) },
        });
      }, { unit: "held_reply", logger: deps.logger });
      if (queued) {
        await pushActionDrainAfterCommit(deps, "held_reply_release_drain_push_failed", queued);
      }
      return result;
    },
  };
};
