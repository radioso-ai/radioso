import type { PublicHttpRequestFailure } from "../../shared/infra/http/publicHttpRequest.js";
import type { ApiRequestFailureReason, ApiRequestSkillOutcome } from "./domain.js";

interface ApiRequestSettlement {
  outcome: ApiRequestSkillOutcome;
  reason?: ApiRequestFailureReason;
}

/**
 * The outcome an answer's status settles: any 2xx completes, 404 is `not_found`, any other 4xx is
 * `rejected` except 401, 403 and 429, which say the connection itself cannot be used right now,
 * and 5xx (or a status outside these, such as a redirect with nowhere to go) fails as the
 * upstream's error. No status is retried.
 */
export const outcomeForStatus = (status: number): ApiRequestSettlement => {
  if (status >= 200 && status < 300) return { outcome: "completed" };
  if (status === 404) return { outcome: "not_found" };
  if (status === 401 || status === 403) return { outcome: "failed", reason: "auth_rejected" };
  if (status === 429) return { outcome: "failed", reason: "rate_limited" };
  if (status >= 400 && status < 500) return { outcome: "rejected" };
  return { outcome: "failed", reason: "upstream_error" };
};

const transportFailureReasons: Readonly<Record<PublicHttpRequestFailure, ApiRequestFailureReason>> = {
  blocked: "blocked",
  timeout: "timeout",
  too_large: "response_too_large",
  redirect_refused: "redirect_refused",
  too_many_redirects: "redirect_refused",
  unreachable: "network",
};

export const outcomeForTransportFailure = (failure: PublicHttpRequestFailure): ApiRequestSettlement => ({
  outcome: "failed",
  reason: transportFailureReasons[failure],
});
