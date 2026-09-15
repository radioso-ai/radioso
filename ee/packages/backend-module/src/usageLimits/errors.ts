// Not exported: nothing outside this file needs the details shape by name,
// only through the error classes below.
interface UsageLimitExceededDetails {
  profileKey: string;
  resource: "monthly_answers" | "monthly_conversations" | "stored_documents" | "stored_indexed_bytes" | "monthly_indexed_bytes";
  limit: number;
  used: number;
  periodStart?: string;
  resetAt?: string;
}

export class UsageLimitExceededError extends Error {
  readonly statusCode = 429;
  readonly code = "usage_limit_exceeded";
  readonly details: UsageLimitExceededDetails;

  constructor(details: UsageLimitExceededDetails) {
    super("Usage limit exceeded");
    this.name = "UsageLimitExceededError";
    this.details = details;
  }
}

interface UsageLimitAccountNotFoundDetails {
  accountId: string;
}

/**
 * Thrown when a usage-limit mutation targets an account id that does not
 * exist, instead of relying on the accounts FK violation (which surfaces as
 * an opaque 500). Shape matches `UsageLimitExceededError` so the backend's
 * `isStructuredAppError` duck-typing in the shared error middleware maps it
 * without any route-level catch.
 */
export class UsageLimitAccountNotFoundError extends Error {
  readonly statusCode = 404;
  readonly code = "account_not_found";
  readonly details: UsageLimitAccountNotFoundDetails;

  constructor(details: UsageLimitAccountNotFoundDetails) {
    super("Account not found");
    this.name = "UsageLimitAccountNotFoundError";
    this.details = details;
  }
}
