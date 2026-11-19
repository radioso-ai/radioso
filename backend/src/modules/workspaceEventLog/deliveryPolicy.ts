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

/** What a failed push does to its subscription's streak. */
export const failedDeliveryStreak = (input: {
  previousFailures: number;
  failingSince: Date | null;
  at: Date;
}): { consecutiveFailures: number; failingSince: Date; nextAttemptAt: Date; disable: boolean } => {
  const consecutiveFailures = input.previousFailures + 1;
  const failingSince = input.failingSince ?? input.at;
  return {
    consecutiveFailures,
    failingSince,
    nextAttemptAt: new Date(input.at.getTime() + deliveryBackoffMs(consecutiveFailures)),
    disable: consecutiveFailures >= DISABLE_AFTER_ATTEMPTS
      && input.at.getTime() - failingSince.getTime() >= DISABLE_AFTER_FAILING_MS,
  };
};
