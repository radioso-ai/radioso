export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown): AppError =>
  new AppError(400, "bad_request", message, details);

export const payloadTooLarge = (message = "Request body exceeds maximum size"): AppError =>
  new AppError(413, "payload_too_large", message);

export const unauthorized = (message = "Unauthorized"): AppError =>
  new AppError(401, "unauthorized", message);

export const forbidden = (message = "Forbidden"): AppError =>
  new AppError(403, "forbidden", message);

export const emailVerificationRequired = (message = "Email verification is required before sign-in"): AppError =>
  new AppError(403, "email_verification_required", message);

export const conflict = (message: string): AppError =>
  new AppError(409, "conflict", message);

export const notFound = (message: string): AppError =>
  new AppError(404, "not_found", message);

export const tooManyRequests = (message: string, details?: unknown): AppError =>
  new AppError(429, "rate_limit_exceeded", message, details);

export const serviceUnavailable = (message: string, details?: unknown): AppError =>
  new AppError(503, "service_unavailable", message, details);
