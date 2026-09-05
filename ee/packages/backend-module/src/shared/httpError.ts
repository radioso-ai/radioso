/**
 * Structured HTTP error thrown by EE route handlers and services.
 *
 * The backend's error middleware (`isStructuredAppError` in
 * `backend/src/app/http/middleware/errorHandler.ts`) duck-types on
 * `statusCode` / `code` / `message` / `details`, so any thrown value with
 * that shape is handled correctly. This class keeps that shape while being
 * a real `Error` instance, as required by `@typescript-eslint/only-throw-error`.
 */
export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}
