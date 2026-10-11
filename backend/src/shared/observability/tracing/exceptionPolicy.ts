import type { Attributes } from "@opentelemetry/api";

/**
 * Exception telemetry is content-free. A thrown error's message and stack can
 * carry provider-echoed customer text, so spans record only what code chose:
 * the error class, a typed code, and a numeric status. Correlation lives on the
 * span itself (trace/span ids plus the caller's `radioso.*` attributes).
 */
interface SafeExceptionDescription {
  readonly type: string;
  readonly code?: string;
  readonly status?: number;
}

const NON_ERROR_TYPE = "NonErrorThrown";
const GENERIC_ERROR_TYPE = "Error";

// Structural identifier shapes, not vocabulary: a class name, and a machine
// code such as `context_length_exceeded`, `ECONNRESET`, or `RESOURCE_EXHAUSTED`.
const CLASS_NAME_SHAPE = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
const CODE_SHAPE = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;

const identifierOrUndefined = (value: unknown, shape: RegExp): string | undefined =>
  typeof value === "string" && shape.test(value) ? value : undefined;

const errorType = (error: Error): string => {
  const named = identifierOrUndefined(error.name, CLASS_NAME_SHAPE);
  if (named && named !== GENERIC_ERROR_TYPE) {
    return named;
  }
  const constructorName = identifierOrUndefined(error.constructor.name, CLASS_NAME_SHAPE);
  return constructorName ?? GENERIC_ERROR_TYPE;
};

const httpStatus = (error: Error): number | undefined => {
  const candidate = error as { status?: unknown; statusCode?: unknown };
  const status = candidate.status ?? candidate.statusCode;
  return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : undefined;
};

export const describeException = (error: unknown): SafeExceptionDescription => {
  if (!(error instanceof Error)) {
    return { type: NON_ERROR_TYPE };
  }

  const code = identifierOrUndefined((error as { code?: unknown }).code, CODE_SHAPE);
  const status = httpStatus(error);
  return {
    type: errorType(error),
    ...(code ? { code } : {}),
    ...(status !== undefined ? { status } : {}),
  };
};

export const exceptionEventAttributes = (exception: SafeExceptionDescription): Attributes => ({
  "exception.type": exception.type,
  ...(exception.code ? { "exception.code": exception.code } : {}),
  ...(exception.status !== undefined ? { "http.response.status_code": exception.status } : {}),
});
