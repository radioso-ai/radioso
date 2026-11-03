import type { AbuseControlEntry } from "../contracts/abuseControl.js";

/**
 * The first millisecond at which the sliding window both stores apply admits one more attempt
 * against `entry`, if nothing is spent before then. A block period can end well before this:
 * attempts refused early in a window still count, and the window they fill keeps weighing on the
 * next one until two windows after it began.
 *
 * Mirrors the stores' rule: an attempt is admitted while `previous * overlap + current + 1` stays
 * within the limit, windows sit end to end, and `overlap` is the share of the window before the
 * running one that still lies inside the last `windowMs`. That weighted count only falls as time
 * passes, so the first admitting instant is where it reaches the limit.
 *
 * Returns null when no wait admits an attempt (a limit below one).
 */
export const earliestReadmissionAtMs = (
  entry: Pick<AbuseControlEntry, "attemptCount" | "previousAttemptCount" | "windowStartedAt">,
  policy: { limit: number; windowMs: number },
): number | null => {
  const { limit, windowMs } = policy;
  if (limit < 1 || !(windowMs > 0)) {
    return null;
  }
  const { attemptCount, previousAttemptCount } = entry;
  // Inside the running window: previous * (1 - elapsed / window) + attemptCount + 1.
  // After it ends, the running window is the one that fades: attemptCount * (2 - elapsed / window) + 1.
  const elapsedAtLimitMs = attemptCount + 1 <= limit
    ? previousAttemptCount === 0 ? 0 : windowMs * (1 - (limit - attemptCount - 1) / previousAttemptCount)
    : windowMs * (2 - (limit - 1) / attemptCount);
  // Strictly after the boundary: at it the weighted count equals the limit exactly, and the stores'
  // floating-point arithmetic can land that comparison on either side.
  return entry.windowStartedAt.getTime() + Math.floor(elapsedAtLimitMs) + 1;
};
