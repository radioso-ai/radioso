import { z } from "zod";

import {
  backgroundJobHandler,
  backgroundJobRequest,
  defineBackgroundJob,
  type BackgroundJobHandlerRegistration,
  type BackgroundJobRequest,
} from "../../shared/background-jobs/index.js";
import type { ConversationClassifier } from "./conversationClassifier.js";

const classificationPayload = z.object({
  workspaceId: z.string().min(1),
  conversationId: z.string().min(1),
});

/**
 * Classifies a conversation's attributes in the worker after a turn commits. The payload names the
 * conversation and nothing else; the run reads what it needs when it runs. A failed model call, or
 * an answer outside the schema, fails the job, which retries with backoff and dead-letters after its
 * last attempt.
 *
 * Level-triggered, like the summary refresh: a turn that commits while a run waits folds into it,
 * and one that commits while a run is going makes it run once more, because that run may have read
 * the conversation before the turn's message existed.
 */
export const CONTEXT_CLASSIFICATION_JOB = defineBackgroundJob({
  kind: "context.classification",
  payload: classificationPayload,
  onDuplicateKey: "rerun",
  maxAttempts: 3,
  timeoutSeconds: 60,
  leaseSeconds: 90,
  retryBaseDelaySeconds: 30,
});

/** Keyed by conversation, so a burst of turns yields one waiting run. */
export const contextClassificationRequest = (input: { workspaceId: string; conversationId: string }): BackgroundJobRequest =>
  backgroundJobRequest(
    CONTEXT_CLASSIFICATION_JOB,
    { workspaceId: input.workspaceId, conversationId: input.conversationId },
    { idempotencyKey: input.conversationId },
  );

/** A run that made no call, or found the conversation gone, ends skipped rather than done. */
export const contextClassificationHandler = (classifier: ConversationClassifier): BackgroundJobHandlerRegistration =>
  backgroundJobHandler(CONTEXT_CLASSIFICATION_JOB, async (payload, context) => {
    const result = await classifier.classifyNow({ ...payload, signal: context.signal });
    if (result.outcome.startsWith("skipped_")) {
      return { skipped: result.outcome };
    }
  });
