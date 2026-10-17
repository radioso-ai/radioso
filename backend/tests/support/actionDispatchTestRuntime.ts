import { ActionRequestRepository } from "../../src/db/repositories/actionRequestRepository.js";
import type { ActionHandler } from "../../src/modules/chat/services/actions/actionDispatcher.js";
import { ActionHandlerRegistry } from "../../src/modules/chat/services/actions/actionDispatcher.js";
import {
  ACTION_DISPATCH_JOB,
  createActionDispatchJobHandler,
  type ActionDispatchJobHandlerOptions,
} from "../../src/modules/chat/services/actions/actionDispatchJob.js";
import { BackgroundJobRuntime, defineBackgroundJob } from "../../src/shared/background-jobs/index.js";
import type { Db } from "../../src/shared/infra/kysely/types.js";

/**
 * `next_attempt_at` is computed by Postgres's own clock, which a fake Node timer cannot move, so a
 * row scheduled for a retry genuinely is not due until this much real time has passed — the
 * schedule must be strictly positive, so a test cannot force "due again instantly" the way the
 * production flat 60 s backoff's old `[0]` test override once did. A suite that drains a retry in
 * a tight loop and expects it due again must itself wait at least this long between claims; see
 * `ACTION_DISPATCH_TEST_RETRY_DELAY_MS` below.
 */
const TEST_RETRY_DELAY_SECONDS = 0.05;

/** `TEST_RETRY_DELAY_SECONDS` in milliseconds, for a test to `setTimeout` past before reclaiming. */
export const ACTION_DISPATCH_TEST_RETRY_DELAY_MS = TEST_RETRY_DELAY_SECONDS * 1_000;

/**
 * Drains real `routine_action_requests` rows through the generic runtime (#1509), the same way
 * production does, for tests that previously drove `ActionDispatcher` directly as a convenience.
 */
const testActionDispatchJob = (maxAttempts: number) =>
  defineBackgroundJob({
    kind: ACTION_DISPATCH_JOB.kind,
    payload: ACTION_DISPATCH_JOB.payload,
    onDuplicateKey: ACTION_DISPATCH_JOB.onDuplicateKey,
    maxAttempts,
    leaseSeconds: ACTION_DISPATCH_JOB.policy.leaseSeconds,
    timeoutSeconds: ACTION_DISPATCH_JOB.policy.timeoutSeconds,
    retryBaseDelaySeconds: ACTION_DISPATCH_JOB.policy.retryBaseDelaySeconds,
    retryDelaysSeconds: [TEST_RETRY_DELAY_SECONDS],
  });

export interface ActionDispatchTestRuntime {
  readonly outbox: ActionRequestRepository;
  readonly registry: ActionHandlerRegistry;
  /** One drain, mirroring `ActionDispatcher.dispatchPending()`'s old call shape. */
  dispatchPending(maxJobs?: number): ReturnType<BackgroundJobRuntime["drain"]>;
}

/**
 * Builds a real `ActionRequestRepository`-backed runtime for one test suite: `registrations` seeds
 * the `ActionHandlerRegistry` up front (`ActionDispatcher`'s constructor took the same shape).
 */
export const createActionDispatchTestRuntime = (
  db: Db,
  registrations: { type: string; handler: ActionHandler }[] = [],
  options: { maxAttempts?: number } & Pick<ActionDispatchJobHandlerOptions, "onPersistedOutcome"> = {},
): ActionDispatchTestRuntime => {
  const outbox = new ActionRequestRepository(db);
  const registry = new ActionHandlerRegistry(registrations);
  const runtime = new BackgroundJobRuntime({
    store: outbox,
    handlers: [
      createActionDispatchJobHandler(registry, {
        onPersistedOutcome: options.onPersistedOutcome,
        job: testActionDispatchJob(options.maxAttempts ?? 5),
      }),
    ],
    logger: { debug: () => undefined, warn: () => undefined, error: () => undefined },
  });
  return {
    outbox,
    registry,
    dispatchPending: (maxJobs = 20) => runtime.drain({ maxJobs }),
  };
};
