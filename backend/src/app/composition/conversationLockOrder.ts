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
 *      it), then the thread's row on `email_thread_links` (`FOR UPDATE`), which carries both the
 *      review claim a result is published under and the thread's send budget;
 *   4. the held reply, by a conditional update;
 *   5. the message written;
 *   6. the delivery queued on the action outbox, or the send intent a materialization records.
 *
 * A unit takes any subset, but never a later step before an earlier one, so two units can only
 * wait on each other in one direction. Rows a unit inserts with a fresh key contend with nothing, so
 * where it writes a new message does not matter. Several conversations are locked in id order.
 *
 * The ownership row is the exception: it is created lazily, keyed on the conversation, and an absent
 * row locks nothing, so step 2 alone cannot order two units that both find none. Inserting it
 * contends on that key — a second inserter waits for the first to commit — so a unit that may create
 * it (a claim, a reply, a hand-off) takes step 1 first: the conversation row stands in for the
 * missing ownership row, and creating one is serialized under it.
 *
 * - Policy change and mailbox removal (`mailboxPolicyChange.ts`): the conversations with a live
 *   draft bound to the mailbox and their ownership rows, then the mailbox `FOR UPDATE`, then the
 *   drafts, then each hand-off's ownership row, its conversation already held.
 * - Ingest (`conversationIngest.ts`): the conversation, the new message, then the ownership row
 *   before the drafts the message makes stale, then any hand-off.
 * - Takeover (`conversationOwnershipChanges.ts`): the conversation, then the ownership row it claims
 *   or creates, then the drafts the claim replaces. Transfer and hand-back only update an existing
 *   ownership row: that row, then (a transfer to yourself) the drafts.
 * - Operator reply (`conversationOwnershipReplies.ts`): the conversation, its ownership row, the
 *   drafts it replaces, then the message and its delivery.
 * - Hold, queue, release, discard and automatic dispatch (`heldReplyUnitOfWork.ts`, in the order
 *   `HeldReplyService` takes them): the conversation, its ownership row, the mailbox `FOR SHARE`,
 *   then — for a hold or queue under a review claim — the thread's row, checking the claim still
 *   holds and (a queue) reserving the send budget, then the held reply, the message, then the
 *   delivery or the send intent.
 * - A review's generation charge (`EmailMailboxRepository.reserveGeneration`) is one statement that
 *   locks the thread link before it updates the mailbox. The only units that take the two the other
 *   way round on the same thread are holding or queueing that review's own result, which run after
 *   it under the same review lease, so they never overlap.
 *
 * Only a change that finds a draft born after it locked its conversations takes a conversation out
 * of order: it locks that conversation when it hands it off. Postgres then aborts one of the two as a
 * deadlock victim (`40P01`), and the units that can meet one that way — the policy change, the
 * held-reply commands, and the takeover, transfer, hand-back and reply — run their whole transaction
 * again, a bounded number of times.
 *
 * Known exception, to fix in a follow-up (specs/1403-email-channel/tasks.md): a chat turn that
 * requests a hand-off (`PostgresAssistantTurnPersistence`) creates the ownership row before it locks
 * the conversation row, the reverse of steps 1 then 2. A takeover or reply racing it on the same
 * conversation can deadlock; the takeover or reply, which waits first and so is normally the victim
 * Postgres picks, runs again, but the chat turn itself has no retry if it is the one aborted.
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
 * Returns the conversations it locked.
 */
export const lockConversationsInOrder = async (
  trx: Db,
  workspaceId: string,
  conversationIds: readonly string[],
): Promise<ReadonlySet<string>> => {
  const conversations = new ConversationRepository(trx);
  const ownership = new ConversationOwnershipRepository(trx);
  const locked = new Set<string>();
  for (const conversationId of [...new Set(conversationIds)].sort()) {
    if (await conversations.lockForUpdate(conversationId, workspaceId)) {
      locked.add(conversationId);
      await ownership.loadForUpdate(conversationId);
    }
  }
  return locked;
};
