/**
 * How long a driver's claim on a step lasts. It bounds how long a crashed driver keeps an
 * operation to itself, so it has to outlast a slow provider call and still be short enough
 * that recovery is not an outage.
 */
export const APP_STEP_LEASE_MS = 5 * 60_000;

/**
 * The lease is also the longest one port call may take, deliberately: a call that outlives
 * the claim it was made under has no owner, and committing its result would write on
 * behalf of a driver that no longer owns the operation.
 */

/**
 * How often a driver renews the claim while a port call is in flight. A third of the lease
 * means two consecutive renewals can fail before the claim lapses, so a momentary database
 * hiccup does not hand a live effect to a second driver.
 */
export const APP_STEP_HEARTBEAT_MS = Math.floor(APP_STEP_LEASE_MS / 3);

/** A cancellable wait, so a finished call stops the heartbeat instead of outliving it. */
export interface AppLeaseTimer {
  delay(ms: number): { readonly elapsed: Promise<void>; cancel(): void };
}

export const createAppLeaseTimer = (): AppLeaseTimer => ({
  delay: (ms) => {
    let settle: () => void = () => {};
    const elapsed = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const handle = setTimeout(() => settle(), ms);
    // A pending heartbeat must never be the reason a process stays alive.
    handle.unref?.();
    return {
      elapsed,
      cancel: () => {
        clearTimeout(handle);
        settle();
      },
    };
  },
});

type AppLeasedCall<T> =
  | { readonly held: true; readonly value: T }
  | { readonly held: false; readonly reason: "lease_lost" | "deadline_exceeded" };

interface AppLeasedCallInput<T> {
  /** Renews this driver's claim. `false` means the claim is gone, whatever the reason. */
  readonly renew: () => Promise<boolean>;
  readonly call: () => Promise<T>;
  readonly heartbeatMs: number;
  readonly deadlineMs: number;
  readonly timer: AppLeaseTimer;
}

/**
 * Runs one port call under a claim that is renewed while it runs, and refuses to hand back
 * a result the driver is no longer entitled to act on.
 *
 * A fixed lease with no renewal makes every slow provider a takeover: the second driver
 * claims the same step, calls the same port, and the first driver then commits a cursor it
 * no longer owns. Renewing keeps a live call's claim alive; bounding the call by the lease
 * means a call that cannot be kept alive is abandoned rather than committed. In both
 * refusals the result is discarded and nothing is written — the effect id is stable, so
 * whoever drives the operation next reconciles the same external effect.
 */
export const callUnderAppStepLease = async <T>(input: AppLeasedCallInput<T>): Promise<AppLeasedCall<T>> => {
  const state: { settled: boolean; waiting: { cancel(): void } | null } = { settled: false, waiting: null };

  /**
   * Never settles once the call has answered. The call and this are raced, and a watchdog
   * that resolved on "the call finished" would be racing the call's own result — which
   * microtask lands first is not something either side should depend on.
   */
  const untilTheCallOutlivesItsClaim = async (): Promise<AppLeasedCall<T>> => {
    let waited = 0;
    for (;;) {
      const step = Math.min(input.heartbeatMs, input.deadlineMs - waited);
      if (step <= 0) return { held: false, reason: "deadline_exceeded" };
      const pending = input.timer.delay(step);
      state.waiting = pending;
      await pending.elapsed;
      state.waiting = null;
      if (state.settled) return new Promise<never>(() => {});
      waited += step;
      if (waited >= input.deadlineMs) return { held: false, reason: "deadline_exceeded" };
      const renewed = await input.renew();
      if (state.settled) return new Promise<never>(() => {});
      if (!renewed) return { held: false, reason: "lease_lost" };
    }
  };

  const invocation = input.call().then(
    (value): AppLeasedCall<T> => ({ held: true, value }),
    (error: unknown) => {
      throw error;
    },
  );

  try {
    return await Promise.race([
      invocation.finally(() => {
        state.settled = true;
        state.waiting?.cancel();
      }),
      untilTheCallOutlivesItsClaim(),
    ]);
  } finally {
    state.settled = true;
    state.waiting?.cancel();
    // A call the watchdog outran keeps running; its rejection must not surface as an
    // unhandled one, because this driver has already stopped acting on it.
    void invocation.catch(() => {});
  }
};
