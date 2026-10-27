/**
 * `TurnPlanService.plan`'s own call bound, layered on top of an optional external
 * cancellation `signal` (a turn cancellation): both abort the same returned
 * `AbortController`, so the thrown error looks identical either way to whatever
 * catches it. `timedOut()` is the one place that still knows which fired — set only
 * when this bound's own timer runs, not when the caller's `signal` aborts first.
 */
export const withTimeout = (
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void; timedOut: () => boolean } => {
  const controller = new AbortController();
  let didTimeOut = false;
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }
  const timer = setTimeout(() => {
    didTimeOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
    timedOut: () => didTimeOut,
  };
};
