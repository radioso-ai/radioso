import { isUsageLimitExceededError, USAGE_LIMIT_EXCEEDED_CODE } from "../../../shared/domain/usageLimitPolicy.js";
import type { CopilotExpensiveOperationGuardDependencies } from "../contracts/expensiveOperation.js";

const EXPENSIVE_OPERATION_SCOPE = "api.expensive_authenticated";

export interface CopilotExpensiveOperationSubject {
  accountId: string;
  workspaceId: string;
  operatorUserId: string;
}

/**
 * Raised in place of the transport's own rate-limit error.
 *
 * The underlying error says "Please wait before trying again", which is addressed to a human
 * holding a browser. Ray's caller is a model reading a tool failure out of a transcript, and "wait
 * and try again" is an instruction it can follow immediately — spending another billed call that
 * fails the same way. The refusal therefore states the wait in seconds and tells the model to stop.
 */
export class CopilotExpensiveOperationRateLimitedError extends Error {
  /** Same wire semantics as the refusal it replaces; only the wording is re-addressed. */
  readonly statusCode = 429;
  readonly code = "rate_limit_exceeded";

  constructor(readonly retryAfterSeconds: number | undefined) {
    super(
      "Rate limit reached for expensive Ray operations"
      + (retryAfterSeconds === undefined ? "" : ` (retry after about ${retryAfterSeconds}s)`)
      + ". Do not retry this call in this turn. Answer with what you already have, and tell the operator to try again shortly.",
    );
    this.name = "CopilotExpensiveOperationRateLimitedError";
  }
}

/**
 * Raised in place of the tier's own quota error, for the same reason the rate-limit refusal is
 * reworded: the model reads this out of a transcript, and "Usage limit exceeded" says nothing it
 * can act on. Unlike a rate limit, waiting does not help — the allowance is gone until the period
 * turns over, so the refusal tells the model to stop rather than to try later.
 */
export class CopilotUsageLimitReachedError extends Error {
  readonly statusCode = 429;
  readonly code = USAGE_LIMIT_EXCEEDED_CODE;

  constructor() {
    super(
      "The workspace has used its answer allowance, and every verification run is charged as one answer. "
      + "Do not retry this call or any other verification in this turn. Answer with what you already have, and tell the operator their plan's allowance is exhausted.",
    );
    this.name = "CopilotUsageLimitReachedError";
  }
}

/**
 * Wraps the work a probe performs, not the budget check before it: the allowance is spent inside
 * the owning service, several layers below, and surfaces as the shared usage-limit code.
 */
export const withCopilotSpendRefusals = async <T>(run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    if (isUsageLimitExceededError(error)) throw new CopilotUsageLimitReachedError();
    throw error;
  }
};

const statusCodeOf = (error: unknown): unknown =>
  error && typeof error === "object" && "statusCode" in error ? (error as { statusCode?: unknown }).statusCode : undefined;

const retryAfterSecondsOf = (error: unknown): number | undefined => {
  const details = error && typeof error === "object" && "details" in error ? (error as { details?: unknown }).details : undefined;
  const seconds = details && typeof details === "object" && "retryAfterSeconds" in details
    ? (details as { retryAfterSeconds?: unknown }).retryAfterSeconds
    : undefined;
  return typeof seconds === "number" ? seconds : undefined;
};

/**
 * Spends the operator's expensive-operation budget before the capability runs, and records the
 * refusal when the budget is gone so a rate-limited operator is visible in the audit trail
 * exactly as one refused at an HTTP route would be.
 */
export const enforceCopilotExpensiveOperation = async (
  dependencies: CopilotExpensiveOperationGuardDependencies,
  subject: CopilotExpensiveOperationSubject,
  route: string,
): Promise<void> => {
  const subjectKey = `account:${subject.accountId}:workspace:${subject.workspaceId}:operator:${subject.operatorUserId}`;
  try {
    await dependencies.abuseControl.enforce({
      scope: EXPENSIVE_OPERATION_SCOPE,
      subjectKey,
      ...dependencies.abusePolicy,
    });
  } catch (error) {
    const statusCode = statusCodeOf(error);
    if (statusCode === 429 || statusCode === 503) {
      await dependencies.audit.record({
        accountId: subject.accountId,
        workspaceId: subject.workspaceId,
        eventType: statusCode === 429
          ? "security.rate_limit_enforced"
          : "security.rate_limit_unavailable",
        eventStatus: statusCode === 429 ? "success" : "failure",
        metadata: {
          scope: EXPENSIVE_OPERATION_SCOPE,
          subjectKey,
          principalType: "operator_copilot",
          // The subject key already encodes it, but a key is for bucketing, not for reading:
          // "which operator was refused" should be answerable without parsing one.
          operatorUserId: subject.operatorUserId,
          route,
        },
      }).catch(() => undefined);
    }
    if (statusCode === 429) throw new CopilotExpensiveOperationRateLimitedError(retryAfterSecondsOf(error));
    throw error;
  }
};
