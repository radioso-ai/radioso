const SECOND_MS = 1_000;
const HOUR_MS = 60 * 60 * SECOND_MS;

/** The first retry waits this long; each consecutive failure doubles it, up to {@link MAX_BACKOFF_MS}. */
const FIRST_BACKOFF_MS = 30 * SECOND_MS;
const MAX_BACKOFF_MS = HOUR_MS;

/** A subscription failing this long without a delivery stops, if it has also been tried enough times. */
const DISABLE_AFTER_FAILING_MS = 24 * HOUR_MS;
const DISABLE_AFTER_ATTEMPTS = 5;

/** How long a subscription waits after its `failures`-th consecutive failure: `min(30 s × 2^(n−1), 1 h)`. */
export const deliveryBackoffMs = (failures: number): number =>
  Math.min(FIRST_BACKOFF_MS * 2 ** Math.max(0, failures - 1), MAX_BACKOFF_MS);

/**
 * What a failure streak, the attempt that failed at `at` included, means for its subscription: when
 * the next attempt is due, and whether it has failed long enough, and often enough, to stop.
 */
export const scheduleAfterFailure = (
  streak: { consecutiveFailures: number; failingSince: Date },
  at: Date,
): { nextAttemptAt: Date; disable: boolean } => ({
  nextAttemptAt: new Date(at.getTime() + deliveryBackoffMs(streak.consecutiveFailures)),
  disable: streak.consecutiveFailures >= DISABLE_AFTER_ATTEMPTS
    && at.getTime() - streak.failingSince.getTime() >= DISABLE_AFTER_FAILING_MS,
});
