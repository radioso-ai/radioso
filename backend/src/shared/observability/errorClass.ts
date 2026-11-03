import { isStructuredAppError } from "../domain/errors.js";

/**
 * What kind of error something threw, for a log field: the error's own name when it set one, else
 * its class, so a subclass that leaves `name` alone still reads as itself. Never the message, which
 * can carry a key, a URL or what a caller said.
 */
export const errorClassOf = (error: unknown): string => {
  if (!(error instanceof Error)) return typeof error;
  return error.name && error.name !== "Error" ? error.name : error.constructor.name;
};

/** An error code that reads as an identifier; anything else is not kept, since it could carry text. */
const ERROR_CODE_SHAPE = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * What a failure was, for a log line: its class, and for an `AppError`-shaped error its code and
 * HTTP status (`errorCode`, `statusCode`), which name a refusal without its message. Low
 * cardinality, and never the message itself.
 */
export const failureFieldsOf = (error: unknown): { errorClass: string; errorCode?: string; statusCode?: number } => {
  if (!isStructuredAppError(error) || !ERROR_CODE_SHAPE.test(error.code)) return { errorClass: errorClassOf(error) };
  return { errorClass: errorClassOf(error), errorCode: error.code, statusCode: error.statusCode };
};
