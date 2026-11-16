import OpenAI from "openai";

import { classifyLlmProviderFailure, type LlmProviderFailureClassification } from "./llmProviderFailureClassification.js";
import { parseRetryAfterMs, ProviderHttpError } from "./providerErrors.js";
import { abortReasonOf, isProviderRequestTimeoutError } from "./providerTimeouts.js";

/**
 * How a governed model call retries a provider that pushed back. One retry layer: a governed
 * call asks the provider SDK for no retries of its own (`maxProviderRetries: 0`), so these
 * bounds are the whole of what a call can wait.
 */
export interface ProviderRetryPolicy {
  /** Attempts in total, the first included. */
  readonly maxAttempts: number;
  /** Backoff before the first retry when the provider names no wait; doubles per retry, with equal jitter. */
  readonly baseDelayMs: number;
  /** The longest wait before a retry. A provider asking for longer is not retried at all. */
  readonly maxDelayMs: number;
}

/**
 * The failure kinds that clear with time: a rate limit and a provider outage. An exhausted
 * quota does not (every call fails until someone adds credit), and a rejected request or
 * credential fails the same way again.
 */
const TRANSIENT_KINDS = new Set<LlmProviderFailureClassification["kind"]>(["rate_limited", "provider_unavailable"]);

const transientFailure = (error: unknown): LlmProviderFailureClassification | null => {
  // A call that ran out its own time budget already spent what a retry would need.
  if (isProviderRequestTimeoutError(error)) {
    return null;
  }
  const failure = classifyLlmProviderFailure(error);
  return failure && TRANSIENT_KINDS.has(failure.kind) ? failure : null;
};

const retryAfterMsOf = (error: unknown): number | undefined => {
  if (error instanceof ProviderHttpError) {
    return error.retryAfterMs;
  }
  return error instanceof OpenAI.APIError ? parseRetryAfterMs(error.headers) : undefined;
};

/**
 * How long to wait before retrying the attempt that just failed (1-based), or `null` when it
 * must not be retried: the attempt budget is spent, the failure does not clear with time, or
 * the provider asked for a longer wait than `policy.maxDelayMs`. A provider's `Retry-After` is
 * honoured, plus up to half a backoff step of jitter so a burst of turns told to come back at
 * the same instant does not return together.
 */
export const providerRetryDelayMs = (
  error: unknown,
  attempt: number,
  policy: ProviderRetryPolicy,
  random: () => number = Math.random,
): number | null => {
  if (attempt >= policy.maxAttempts || !transientFailure(error)) {
    return null;
  }
  const backoffMs = policy.baseDelayMs * 2 ** (attempt - 1);
  const retryAfterMs = retryAfterMsOf(error);
  if (retryAfterMs !== undefined) {
    return retryAfterMs > policy.maxDelayMs
      ? null
      : Math.min(policy.maxDelayMs, retryAfterMs + random() * (backoffMs / 2));
  }
  return Math.min(policy.maxDelayMs, backoffMs / 2 + random() * (backoffMs / 2));
};

/** Waits `ms`, or rejects with the signal's reason as soon as it aborts. */
export const sleepUnlessAborted = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReasonOf(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReasonOf(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
