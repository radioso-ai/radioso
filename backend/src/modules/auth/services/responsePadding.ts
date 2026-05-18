const sleep = (durationMs: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, durationMs);
});

export const DEFAULT_AUTH_EMAIL_FLOW_MIN_RESPONSE_MS = 250;

export const waitForMinimumElapsed = async (
  startedAtMs: number,
  minimumDurationMs: number,
): Promise<void> => {
  if (minimumDurationMs <= 0) {
    return;
  }

  const remainingMs = minimumDurationMs - (Date.now() - startedAtMs);
  if (remainingMs > 0) {
    await sleep(remainingMs);
  }
};
