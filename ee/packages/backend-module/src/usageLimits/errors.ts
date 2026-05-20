export interface UsageLimitExceededDetails {
  profileKey: string;
  resource: "monthly_answers" | "stored_documents" | "stored_indexed_bytes" | "monthly_indexed_bytes";
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

export const isUsageLimitExceededError = (error: unknown): error is UsageLimitExceededError =>
  Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "usage_limit_exceeded",
  );
