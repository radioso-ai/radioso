import type { Response } from "express";

import type { AbuseControlDecision } from "../../modules/security/contracts/abuseControl.js";

/**
 * The one place an abuse-control decision becomes HTTP. Fields follow
 * draft-ietf-httpapi-ratelimit-headers: `RateLimit-Reset` counts seconds from now, and
 * `Retry-After` is only meaningful once the caller has actually been turned away.
 *
 * Nothing here knows which route, limiter, or store produced the decision.
 */

const secondsUntil = (atMs: number): number => Math.max(0, Math.ceil((atMs - Date.now()) / 1000));

const positiveSeconds = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.ceil(value) : null;

const decisionFromDetails = (details: unknown): AbuseControlDecision | null => {
  if (!details || typeof details !== "object") {
    return null;
  }
  const candidate = details as Record<string, unknown>;
  if (
    typeof candidate.limit !== "number"
    || typeof candidate.remaining !== "number"
    || typeof candidate.resetAtMs !== "number"
  ) {
    return null;
  }
  return {
    limit: candidate.limit,
    remaining: candidate.remaining,
    resetAtMs: candidate.resetAtMs,
    ...(typeof candidate.retryAfterSeconds === "number" ? { retryAfterSeconds: candidate.retryAfterSeconds } : {}),
  };
};

export const applyRateLimitHeaders = (res: Response, decision: AbuseControlDecision): void => {
  res.setHeader("RateLimit-Limit", String(decision.limit));
  res.setHeader("RateLimit-Remaining", String(Math.max(0, decision.remaining)));
  res.setHeader("RateLimit-Reset", String(secondsUntil(decision.resetAtMs)));
  const retryAfterSeconds = positiveSeconds(decision.retryAfterSeconds);
  if (retryAfterSeconds !== null) {
    res.setHeader("Retry-After", String(retryAfterSeconds));
  }
};

/**
 * Applied to every error response, so a 429 raised away from the rate-limit middleware — a usage
 * cap, a guard around an expensive operation — still tells the caller when to come back.
 */
export const applyRetryAfterFromError = (res: Response, error: { statusCode: number; details?: unknown }): void => {
  if (error.statusCode !== 429) {
    return;
  }
  const decision = decisionFromDetails(error.details);
  if (decision) {
    applyRateLimitHeaders(res, decision);
    return;
  }
  const details = error.details;
  const retryAfterSeconds = positiveSeconds(
    details && typeof details === "object" ? (details as Record<string, unknown>).retryAfterSeconds : undefined,
  );
  if (retryAfterSeconds !== null) {
    res.setHeader("Retry-After", String(retryAfterSeconds));
  }
};
