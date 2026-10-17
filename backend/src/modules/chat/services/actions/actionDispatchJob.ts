import { z } from "zod";

import type { ActionDispatchJobPayload } from "../../../../db/repositories/actionRequestRepository.js";
import {
  backgroundJobHandler,
  defineBackgroundJob,
  type BackgroundJobHandlerRegistration,
} from "../../../../shared/background-jobs/index.js";
import type { BackgroundJobKind } from "../../../../shared/background-jobs/types.js";
import { stringifyUnknown } from "../../../../shared/text/stringifyUnknown.js";
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
 * {@link createActionDispatchJobHandler} routes on it. Five attempts. `timeoutSeconds` is new: no
 * bespoke timeout ever bounded a handler call before this move; 120 s comfortably bounds every
 * current handler's transport (Resend's own timeout is 15 s, the webhook client's is 10 s), while
 * leaving most of the drain budget free to admit more jobs per call (see
 * `actionDispatchWorkerTaskRoutes.ts`) — the substrate's own 240 s ceiling would have left only
 * 30 s of a 270 s drain budget for admitting work. A handler that ignores its (unused) `signal`
 * keeps running in the background exactly as the substrate documents for any kind that does this.
 *
 * `retryDelaysSeconds` grows instead of staying flat: the old `ActionDispatchWorker` never woke a
 * retry early, so a flat 60 s backoff still spent roughly 20 minutes riding out a transient outage
 * across 5 attempts in practice (each retry waited for the next poll tick or the 5-minute sweep,
 * not its own 60 s). This runtime wakes a retry at its own `availableAt`, so a flat 60 s schedule
 * here would exhaust all 5 attempts in about 4 minutes — failing a 5-minute Resend or webhook
 * outage for good instead of riding it out. `[60, 120, 300, 600]` (18 minutes across 4 retries)
 * keeps that old effective window.
 */
export const ACTION_DISPATCH_JOB = defineBackgroundJob({
  kind: "chat.action_dispatch",
  payload: actionDispatchJobPayloadSchema,
  onDuplicateKey: "ignore",
  maxAttempts: 5,
  leaseSeconds: 300,
  timeoutSeconds: 120,
  retryBaseDelaySeconds: 60,
  retryDelaysSeconds: [60, 120, 300, 600],
});

/** The registry slice this adapter needs: resolving a handler by the row's own action `type`. */
interface ActionHandlerResolver {
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
   * Logs a throwing `onPersistedOutcome` observer by error class only — never the error's message,
   * which a best-effort observer (a cache invalidation) has no documented obligation to keep free
   * of customer content. Omit in tests that do not care.
   */
  logger?: { warn(payload: Record<string, unknown>, message: string): void };
  /**
   * Overrides `ACTION_DISPATCH_JOB` — for tests only, so a suite that drains retries in a tight
   * loop against real Postgres (where a fake clock cannot move the database's own `now()`) can use
   * a near-zero `retryDelaysSeconds` instead of the production flat 60 s. Production composition
   * never sets this.
   */
  job?: BackgroundJobKind<ActionDispatchJobPayload>;
}

/** The error's own name/constructor only — never its message, which a throwing observer's cause may not keep free of customer content. */
const observerErrorClass = (error: unknown): string => (error instanceof Error ? error.name : typeof error);

/**
 * `ActionDispatcher` handed its handlers the real caught-and-stringified error text (never a
 * generic class-only summary); this reproduces that from the runtime's `cause` — the underlying
 * error itself, kept out of every store column, log, and the error reporter — so a handler's own
 * bounded extraction (`contactSendActionHandler`'s trailing HTTP status code) still works. `null`
 * for a synthetic failure (lease expiry, an unparseable stored payload) with no error to describe.
 */
const causeMessage = (cause: unknown): string | null => {
  if (cause === undefined) return null;
  return cause instanceof Error ? cause.message : stringifyUnknown(cause);
};

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
 *
 * Two edge cases this inherits from the generic runtime (see the background-jobs README):
 * a request whose last attempt's lease expired (a crashed or stalled worker) is dead-lettered on
 * its next claim without running again, so `recordFailureOutcome("failed")` can be recorded for
 * an action whose handler may have already sent it — the crash that lost the lease could have
 * happened after the real delivery, not before; and a `recordFailureOutcome` call that hits its
 * own pool's connection timeout under mass failure is dropped (the row's retry or terminal `failed`
 * write still commits) rather than retried, so its side effect — an alert, a cache invalidation —
 * is silently lost that one time.
 */
export const createActionDispatchJobHandler = (
  registry: ActionHandlerResolver,
  options: ActionDispatchJobHandlerOptions = {},
): BackgroundJobHandlerRegistration => {
  // The persisted outbox transition (the row's own claim/retry/dead-letter/skip write) is
  // authoritative; a downstream observer (a best-effort cache invalidation) cannot undo or
  // reclassify it, and must never turn a real send into a resend — a throw here is isolated,
  // not left to fail the run, the same isolation `ActionDispatcher` gave this call.
  const observe = (request: ActionDispatchJobPayload, outcome: ActionDispatchPersistedOutcome): void => {
    try {
      options.onPersistedOutcome?.({ request, outcome });
    } catch (error) {
      options.logger?.warn(
        { outcome, errorType: observerErrorClass(error) },
        "Action dispatch's persisted-outcome observer failed; the outcome itself is unaffected",
      );
    }
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
          // Falls back to the class-only summary only for a synthetic failure with no real error.
          error: causeMessage(context.cause) ?? context.error,
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
          error: causeMessage(context.cause) ?? context.error,
        });
      },
    },
  );
};
