import { z } from "zod";

import {
  backgroundJobHandler,
  backgroundJobRequest,
  defineBackgroundJob,
  type BackgroundJobHandlerRegistration,
  type BackgroundJobRequest,
} from "../../../../shared/background-jobs/index.js";
import type { ConversationSummaryUpdater } from "./conversationSummaryService.js";

const refreshPayload = z.object({
  workspaceId: z.string().min(1),
  conversationId: z.string().min(1),
  accountId: z.string().min(1).optional(),
});

/**
 * Regenerates a conversation's rolling summary and title (#866, #1114, #1129) in the worker after
 * a turn commits. The payload names the conversation and nothing else; the refresh reads the
 * messages it needs when it runs. A refresh that fails inside the summary service is logged there
 * and heals on the next turn's refresh, so the job's own retries cover a worker that died mid-run.
 */
export const CONVERSATION_SUMMARY_REFRESH_JOB = defineBackgroundJob({
  kind: "conversation.summary_refresh",
  payload: refreshPayload,
  maxAttempts: 3,
  // A first summary for a long conversation runs a capped backfill of several model calls.
  leaseSeconds: 300,
  retryBaseDelaySeconds: 30,
});

/**
 * One refresh per conversation at a time: a burst of turns while a refresh waits or runs adds no
 * second job. The waiting refresh reads the conversation when it runs, and a turn that commits
 * while one is already running is covered by the next turn's refresh.
 */
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

export const conversationSummaryRefreshHandler = (
  updater: ConversationSummaryUpdater,
): BackgroundJobHandlerRegistration =>
  backgroundJobHandler(CONVERSATION_SUMMARY_REFRESH_JOB, (payload) => updater.refresh(payload));
