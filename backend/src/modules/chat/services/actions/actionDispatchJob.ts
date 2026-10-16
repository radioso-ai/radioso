import { z } from "zod";

import type { ActionDispatchJobPayload } from "../../../../db/repositories/actionRequestRepository.js";
import {
  backgroundJobHandler,
  defineBackgroundJob,
  type BackgroundJobHandlerRegistration,
} from "../../../../shared/background-jobs/index.js";
import type { BackgroundJobKind } from "../../../../shared/background-jobs/types.js";
import { ActionDispatchSkippedError, type ActionHandler, type ActionHandlerContext } from "./actionDispatcher.js";

const actionDispatchJobPayloadSchema: z.ZodType<ActionDispatchJobPayload> = z.object({
  type: z.string(),
  payload: z.record(z.unknown()),
  workspaceId: z.string().nullable(),
  accountId: z.string().nullable(),
  conversationId: z.string().nullable(),
  idempotencyKey: z.string().nullable(),
  skillName: z.string().nullable(),
});

/**
 * The one job kind every routine action request rides, whatever its own `type` — the generic
 * runtime addresses a kind by name, not by this table's `type` column, so the real type travels
 * inside the payload (`ActionRequestRepository.claimNext`'s claim mapping) and
 * {@link createActionDispatchJobHandler} routes on it. Five attempts and a flat 60 s retry carry
 * over the outbox's existing contract unchanged. `timeoutSeconds` is new: no bespoke timeout ever
 * bounded a handler call before this move; 240 s is the substrate's own ceiling, comfortably above
 * any current handler's real latency, and a handler that ignores its (unused) `signal` keeps
 * running in the background exactly as the substrate documents for any kind that does this.
 */
export const ACTION_DISPATCH_JOB = defineBackgroundJob({
  kind: "chat.action_dispatch",
  payload: actionDispatchJobPayloadSchema,
  onDuplicateKey: "ignore",
  maxAttempts: 5,
  leaseSeconds: 300,
  timeoutSeconds: 240,
  retryBaseDelaySeconds: 60,
  retryDelaysSeconds: [60],
});

/** The registry slice this adapter needs: resolving a handler by the row's own action `type`. */
export interface ActionHandlerResolver {
  resolve(type: string): ActionHandler | null;
}

/**
 * The persisted-outcome events `ActionDispatcher` used to report to a product-neutral observer
 * (for example, invalidating a workspace's cached contact-delivery status). `claimed`, `dispatched`,
 * and `skipped` fire from this handler's own hook points rather than a confirmed store write — the
 * generic port fences `retry`/`failed` for us (the hook that reports them only runs once the
 * reschedule or park actually lands), but has no equivalent hook at claim or completion time. A
 * consumer of this event is assumed best-effort (a cache invalidation, not a correctness path):
 * over-reporting on a claim a concurrent worker goes on to steal is harmless.
 */
export type ActionDispatchPersistedOutcome = "claimed" | "dispatched" | "skipped" | "retry" | "failed";

export interface ActionDispatchJobHandlerOptions {
  onPersistedOutcome?: (input: { request: ActionDispatchJobPayload; outcome: ActionDispatchPersistedOutcome }) => void;
  /**
   * Overrides `ACTION_DISPATCH_JOB` — for tests only, so a suite that drains retries in a tight
   * loop against real Postgres (where a fake clock cannot move the database's own `now()`) can use
   * a near-zero `retryDelaysSeconds` instead of the production flat 60 s. Production composition
   * never sets this.
   */
  job?: BackgroundJobKind<ActionDispatchJobPayload>;
}

const toHandlerContext = (
  payload: ActionDispatchJobPayload,
  jobId: string,
  attempt: number,
): ActionHandlerContext => ({
  requestId: jobId,
  workspaceId: payload.workspaceId,
  accountId: payload.accountId,
  conversationId: payload.conversationId,
  idempotencyKey: payload.idempotencyKey,
  attempt,
  skillName: payload.skillName,
});

/**
 * Adapts one claimed action request to the `ActionHandler` registry — the whole reason this job
 * kind exists, so `ActionHandler` implementations never change. Resolves the row's own `type` (not
 * `ACTION_DISPATCH_JOB.kind`, which names this one generic job for every type), runs it, and turns
 * a thrown `ActionDispatchSkippedError` into the runtime's `skipped` outcome instead of a retry. An
 * unregistered type fails the run (retried, then dead-lettered, by the generic policy) without
 * calling `recordFailureOutcome` — there is no handler to call it on, matching
 * `ActionDispatcher`'s prior behaviour. `recordFailureOutcome` otherwise rides the per-attempt hook
 * for a retry and `onDeadLetter` for the terminal failure, reproducing the single hook's two
 * outcomes `ActionDispatcher` used to report.
 */
export const createActionDispatchJobHandler = (
  registry: ActionHandlerResolver,
  options: ActionDispatchJobHandlerOptions = {},
): BackgroundJobHandlerRegistration => {
  const observe = (request: ActionDispatchJobPayload, outcome: ActionDispatchPersistedOutcome): void => {
    options.onPersistedOutcome?.({ request, outcome });
  };
  return backgroundJobHandler(
    options.job ?? ACTION_DISPATCH_JOB,
    async (payload, context) => {
      observe(payload, "claimed");
      const handler = registry.resolve(payload.type);
      if (!handler) {
        throw new Error(`no_handler_for_type:${payload.type}`);
      }
      try {
        await handler.handle({
          payload: payload.payload,
          context: toHandlerContext(payload, context.jobId, context.attempt),
        });
      } catch (error) {
        if (error instanceof ActionDispatchSkippedError) {
          observe(payload, "skipped");
          return { skipped: error.reason };
        }
        throw error;
      }
      observe(payload, "dispatched");
    },
    {
      onAttemptFailed: async (payload, context) => {
        if (!payload) {
          return;
        }
        observe(payload, "retry");
        const handler = registry.resolve(payload.type);
        if (!handler?.recordFailureOutcome) {
          return;
        }
        await handler.recordFailureOutcome({
          payload: payload.payload,
          context: toHandlerContext(payload, context.jobId, context.attempt),
          outcome: "retry",
          error: context.error,
        });
      },
      onDeadLetter: async (payload, context) => {
        if (!payload) {
          return;
        }
        observe(payload, "failed");
        const handler = registry.resolve(payload.type);
        if (!handler?.recordFailureOutcome) {
          return;
        }
        await handler.recordFailureOutcome({
          payload: payload.payload,
          context: toHandlerContext(payload, context.jobId, context.attempt),
          outcome: "failed",
          error: context.error,
        });
      },
    },
  );
};
