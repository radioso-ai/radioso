/**
 * Failures an `EmailDriver` raises. Kept apart from `emailService.ts` so provider adapters can
 * extend them without importing the module that constructs those adapters.
 */

/**
 * How certain a failed send is that nothing went out:
 * - `rejected`: the provider refused the request, or it never left Radioso. Nothing was sent, and
 *   sending the same request again will not succeed.
 * - `retryable`: the provider turned this request away for a transient reason without accepting
 *   it. Re-send it unchanged, with the same idempotency key. For `idempotency_in_flight`, an
 *   earlier request under the same key may still be accepted.
 * - `unknown`: the provider may have accepted it. Only a re-send with the same idempotency key
 *   and an identical body, or a `lookup`, can settle it.
 */
export type EmailSendOutcome = "rejected" | "retryable" | "unknown";

export type EmailProviderFailureCode =
  | "rejected"
  | "auth"
  | "not_found"
  | "rate_limited"
  | "idempotency_body_mismatch"
  | "idempotency_in_flight"
  | "unrecognized_conflict"
  | "unavailable"
  | "timeout"
  | "unreachable"
  | "malformed_response"
  | "invalid_header_value";

/** A failed send. Carries a classification and a sanitized code, never message content. */
export class EmailSendError extends Error {
  constructor(
    readonly outcome: EmailSendOutcome,
    readonly code: EmailProviderFailureCode,
    message: string = code,
  ) {
    super(message);
    this.name = "EmailSendError";
  }
}

/** A failed `lookup`. `retryable` means a later lookup may succeed. */
export class EmailLookupError extends Error {
  constructor(
    readonly retryable: boolean,
    readonly code: EmailProviderFailureCode,
  ) {
    super(code);
    this.name = "EmailLookupError";
  }
}
