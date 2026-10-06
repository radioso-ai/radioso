import type { Kysely } from "kysely";

import { ConversationOwnershipRepository } from "../../db/repositories/conversationOwnershipRepository.js";
import { ConversationRepository } from "../../db/repositories/conversationRepository.js";
import type { DB, Db } from "../../shared/infra/kysely/types.js";

/*
 * The conversation lock protocol: the one order in which every unit of work that touches a
 * conversation's ownership, its held replies or the policy a draft is bound to takes its row locks.
 *
 *   1. the conversation row (`FOR NO KEY UPDATE`);
 *   2. its ownership row (`FOR UPDATE`);
 *   3. the channel's policy: an email mailbox row (`FOR SHARE` to read it, `FOR UPDATE` to change
 *      it), then the thread's send budget on `email_thread_links`;
 *   4. the held reply, by a conditional update;
 *   5. the message written;
 *   6. the delivery queued on the action outbox, or the send intent a materialization records.
 *
 * A unit takes any subset, but never a later step before an earlier one, so two units can only
 * wait on each other in one direction. Rows a unit inserts contend with nothing, so where it writes
 * a new message does not matter. Several conversations are locked in id order.
 *
 * - Policy change and mailbox removal (`mailboxPolicyChange.ts`): the conversations with a live
 *   draft bound to the mailbox and their ownership rows, then the mailbox `FOR UPDATE`, then the
 *   drafts, then each hand-off's ownership row again, already held.
 * - Ingest (`conversationIngest.ts`): the conversation, the new message, then the ownership row
 *   before the drafts the message makes stale, then any hand-off.
 * - Takeover, transfer and hand-back (`conversationOwnershipChanges.ts`): the ownership row, then
 *   the drafts the claim replaces.
 * - Operator reply (`conversationOwnershipReplies.ts`): the conversation, its ownership row, the
 *   drafts it replaces, then the message and its delivery.
 * - Hold, queue, release, discard and automatic dispatch (`heldReplyUnitOfWork.ts`, in the order
 *   `HeldReplyService` takes them): the conversation, its ownership row, the mailbox `FOR SHARE`,
 *   the held reply, the message, then the delivery or the send intent.
 * - A review's generation charge (`EmailMailboxRepository.reserveGeneration`) is one statement that
 *   locks the thread link before it updates the mailbox. The only unit that takes the two the other
 *   way round on the same thread is queueing that review's own reply, which runs after it under the
 *   same review lease, so the two never overlap.
 *
 * Only a change that finds a draft born after it locked its conversations takes a conversation out
 * of order; Postgres then aborts one of the two as a deadlock victim (`40P01`), and the units that
 * can meet one that way — the policy change and the held-reply commands — run their whole
 * transaction again, a bounded number of times.
 */

/** Postgres' `deadlock_detected`: the transaction was chosen as a deadlock's victim and rolled back whole. */
const DEADLOCK_DETECTED = "40P01";
const DEFAULT_MAX_ATTEMPTS = 3;

const isDeadlockVictim = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === DEADLOCK_DETECTED;

/**
 * Runs `work` in one transaction, and again from the start, up to `maxAttempts` in all, while
 * Postgres aborts it as a deadlock victim. Nothing of an aborted attempt committed, so the work
 * must keep its effects inside the transaction and reset whatever it records per attempt.
 */
export const runTransactionWithDeadlockRetry = async <T>(
  db: Kysely<DB>,
  work: (trx: Db) => Promise<T>,
  options: { unit: string; maxAttempts?: number; logger?: { warn(fields: Record<string, unknown>, message: string): void } },
): Promise<T> => {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await db.transaction().execute(work);
    } catch (error) {
      if (!isDeadlockVictim(error) || attempt >= maxAttempts) throw error;
      options.logger?.warn({ unit: options.unit, attempt, maxAttempts }, "transaction_deadlock_retried");
    }
  }
};

/**
 * Takes steps 1 and 2 of the protocol for several conversations of a workspace: each conversation
 * row, then its ownership row, in id order. A conversation outside the workspace is left alone.
 */
export const lockConversationsInOrder = async (trx: Db, workspaceId: string, conversationIds: readonly string[]): Promise<void> => {
  const conversations = new ConversationRepository(trx);
  const ownership = new ConversationOwnershipRepository(trx);
  for (const conversationId of [...new Set(conversationIds)].sort()) {
    if (await conversations.lockForUpdate(conversationId, workspaceId)) {
      await ownership.loadForUpdate(conversationId);
    }
  }
};
