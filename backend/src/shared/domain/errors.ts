interface AppErrorOptions {
  /**
   * True for an AppError whose `statusCode` is `>= 500` but whose cause is still an
   * expected, non-platform outcome — a disconnected client, not a platform fault.
   * Error reporting then treats it the same as a `< 500` AppError: not a fault.
   * Unset (the default) for every other AppError, including a 5xx platform
   * misconfiguration or a rejected platform credential — those ARE faults.
   */
  isExpectedOutcome?: boolean;
}

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;
  readonly isExpectedOutcome: boolean;

  constructor(statusCode: number, code: string, message: string, details?: unknown, options?: AppErrorOptions) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isExpectedOutcome = options?.isExpectedOutcome === true;
  }
}

/**
 * A client-facing error shaped like `AppError` (`statusCode`, `code`, `message`)
 * without necessarily being one. The Enterprise backend module throws plain `Error`
 * subclasses with this exact shape instead of importing the OSS `AppError` class (see
 * `ee/packages/backend-module/src/usageLimits/errors.ts` and `.../shared/httpError.ts`)
 * — a real `AppError` always satisfies this too, so callers that only care about the
 * shape (the error handler's response-building, `isReportableFault`) read one type
 * instead of an `instanceof` check plus a duck-typed fallback.
 */
interface StructuredAppError {
  statusCode: number;
  code: string;
  message: string;
  details?: unknown;
  /** Present on a real `AppError`; absent (not `false`) on a duck-typed one. */
  isExpectedOutcome?: boolean;
}

export const isStructuredAppError = (error: unknown): error is StructuredAppError =>
  Boolean(
    error &&
      typeof error === "object" &&
      "statusCode" in error &&
      typeof error.statusCode === "number" &&
      "code" in error &&
      typeof error.code === "string" &&
      "message" in error &&
      typeof error.message === "string",
  );

/**
 * Whether `error` is a fault worth reporting to error tracking — not the same question
 * as "did an operation fail". A client-facing, `AppError`-shaped error (real or
 * duck-typed — see {@link StructuredAppError}) means the system already produced a
 * deliberate, typed outcome; one under 500 (a quota or validation limit, a superseded
 * turn, anything the caller is meant to act on) is expected, not a fault. A `>= 500`
 * one is still a fault by default — a missing encryption key, a misconfigured
 * provider, or a rejected platform credential all surface this way, and hiding them
 * from error tracking is exactly what let the Azure undeployed-model incident go
 * unreported — unless its own `isExpectedOutcome` marker says otherwise (a
 * disconnected client), which this reads as a typed property rather than importing a
 * caller module's error classes into whatever generic layer calls this. Anything that
 * is not even this shape (a bare thrown value, a programming error) is always a fault.
 */
export const isReportableFault = (error: unknown): boolean => {
  if (!isStructuredAppError(error)) {
    return true;
  }
  if (error.isExpectedOutcome === true) {
    return false;
  }
  return error.statusCode >= 500;
};

export const badRequest = (message: string, details?: unknown): AppError =>
  new AppError(400, "bad_request", message, details);

export const payloadTooLarge = (message = "Request body exceeds maximum size", details?: unknown): AppError =>
  new AppError(413, "payload_too_large", message, details);

export const unauthorized = (message = "Unauthorized"): AppError =>
  new AppError(401, "unauthorized", message);

export const forbidden = (message = "Forbidden"): AppError =>
  new AppError(403, "forbidden", message);

export const conflict = (message: string): AppError =>
  new AppError(409, "conflict", message);

export const notFound = (message: string, details?: unknown): AppError =>
  new AppError(404, "not_found", message, details);

export const tooManyRequests = (message: string, details?: unknown): AppError =>
  new AppError(429, "rate_limit_exceeded", message, details);

export const usageLimitExceeded = (message: string, details?: unknown): AppError =>
  new AppError(429, "usage_limit_exceeded", message, details);

export const serviceUnavailable = (message: string, details?: unknown): AppError =>
  new AppError(503, "service_unavailable", message, details);
