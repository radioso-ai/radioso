import { z } from "zod";

import {
  backgroundJobHandler,
  backgroundJobRequest,
  defineBackgroundJob,
  type BackgroundJobHandlerRegistration,
  type BackgroundJobRequest,
} from "../../../../shared/background-jobs/index.js";
import type { ConversationRepositoryPort } from "../../../../db/repositories/conversationRepository.js";
import type { ConversationSummaryUpdater } from "./conversationSummaryService.js";

const refreshPayload = z.object({
  workspaceId: z.string().min(1),
  conversationId: z.string().min(1),
  accountId: z.string().min(1).optional(),
});

/**
 * Regenerates a conversation's rolling summary and title (#866, #1114, #1129) in the worker after
 * a turn commits. The payload names the conversation and nothing else; the refresh reads the
 * messages it needs when it runs. A failed model call or save fails the job, which retries with
 * backoff and dead-letters after its last attempt.
 *
 * Level-triggered: a turn that commits while a refresh waits is folded into it, and one that
 * commits while a refresh runs makes it run once more, because that run may have read the
 * conversation before the turn's message existed.
 */
export const CONVERSATION_SUMMARY_REFRESH_JOB = defineBackgroundJob({
  kind: "conversation.summary_refresh",
  payload: refreshPayload,
  onDuplicateKey: "rerun",
  maxAttempts: 3,
  // A first summary for a long conversation runs a capped backfill of several model calls.
  timeoutSeconds: 120,
  leaseSeconds: 180,
  retryBaseDelaySeconds: 30,
});

/** Keyed by conversation, so a burst of turns yields one waiting refresh. */
export const conversationSummaryRefreshRequest = (input: {
  workspaceId: string;
  conversationId: string;
  accountId?: string;
}): BackgroundJobRequest =>
  backgroundJobRequest(
    CONVERSATION_SUMMARY_REFRESH_JOB,
    {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      ...(input.accountId ? { accountId: input.accountId } : {}),
    },
    { idempotencyKey: input.conversationId },
  );

/** Finds the conversation a refresh names; an erased conversation has nothing left to summarize. */
type SummaryRefreshConversations = Pick<ConversationRepositoryPort, "findByIdAndWorkspaceId">;

const CONVERSATION_ERASED = { skipped: "conversation_not_found" } as const;

/**
 * Runs the refresh unless the conversation is gone. An erasure deletes the conversation but not a
 * refresh already queued for it, so the job checks first, and a refresh whose save fails because
 * an erasure committed mid-run ends skipped as well instead of spending its retries.
 */
export const conversationSummaryRefreshHandler = (
  updater: ConversationSummaryUpdater,
  conversations: SummaryRefreshConversations,
): BackgroundJobHandlerRegistration =>
  backgroundJobHandler(CONVERSATION_SUMMARY_REFRESH_JOB, async (payload, context) => {
    const present = async () =>
      (await conversations.findByIdAndWorkspaceId(payload.conversationId, payload.workspaceId)) !== null;
    if (!(await present())) {
      return CONVERSATION_ERASED;
    }
    try {
      await updater.refresh(payload, { signal: context.signal });
    } catch (error) {
      if (!(await present())) {
        return CONVERSATION_ERASED;
      }
      throw error;
    }
  });
