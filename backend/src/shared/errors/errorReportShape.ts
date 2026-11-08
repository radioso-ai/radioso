import { isClassName, isCode, isErrorSummary, isStackFrame, isUuid, safeErrorFields } from "../observability/logging/logSafeValues.js";
import type { ErrorIdentity, ErrorReportMessage, ErrorStackFrames } from "./errorTypes.js";

// What an error report keeps of an error, and the only constructors of the branded message and
// stack an `ErrorEvent` carries. It reads an error through `safeErrorFields`, the same shape checks
// the app logger applies, so an error reads the same way in a log line and in every error sink.

const REDACTED = "[REDACTED]";

// A class name, a class and its code (`AppError [not_found]`), a lowercase code, an id, or a finite
// number: each rules out a sentence.
const isMessageSafe = (value: string | number): boolean =>
  typeof value === "number" ? Number.isFinite(value) : isErrorSummary(value) || isCode(value) || isUuid(value);

/**
 * A readable message for an error report, written as a tagged template, such as
 * errorReportMessage`${kind} dead-lettered: ${summary}`. The literal text is source code. Each
 * value must be a class name, a class and its code, a lowercase code, an id or a number; any other
 * value, such as an error's own message, reads as `[REDACTED]`.
 */
export const errorReportMessage = (text: TemplateStringsArray, ...values: ReadonlyArray<string | number>): ErrorReportMessage =>
  values.reduce<string>(
    (message, value, index) => `${message}${isMessageSafe(value) ? String(value) : REDACTED}${text[index + 1] ?? ""}`,
    text[0] ?? "",
  ) as ErrorReportMessage;

/** The frames of a stack held as text, such as a browser's: every other line goes, the message line included. */
export const stackFramesOf = (stack: unknown): ErrorStackFrames | undefined => {
  const frames = (typeof stack === "string" ? stack : "").split("\n").filter(isStackFrame);
  return frames.length > 0 ? (frames.join("\n") as ErrorStackFrames) : undefined;
};

const identityOf = (errorClass: string, code: string | number | undefined): ErrorIdentity =>
  code === undefined ? { errorClass } : { errorClass, code };

interface RedactedErrorFields {
  identity?: ErrorIdentity;
  causes: ErrorIdentity[];
  stack?: ErrorStackFrames;
}

const errorClassOf = (error: unknown, safeName: string): string =>
  error instanceof Error ? safeName : typeof error === "object" ? "NonErrorThrowable" : typeof error;

/**
 * What a report keeps of a caught value: its class and code, the class and code of each error it
 * wraps, and its stack frames minus the first line, which restates the message. A thrown value
 * that is not an `Error` is a `NonErrorThrowable`, or named by its JS type when it is a primitive.
 * A caller's `errorClass` names the report instead when it is shaped like a class name, and a
 * caller's `stack` text gives its frames instead.
 */
export const redactedErrorFields = (input: { error?: unknown; errorClass?: string; stack?: string }): RedactedErrorFields => {
  const fields = input.error === undefined || input.error === null ? undefined : safeErrorFields(input.error);
  const errorClass =
    input.errorClass !== undefined && isClassName(input.errorClass) ? input.errorClass : fields && errorClassOf(input.error, fields.name);
  const causes: ErrorIdentity[] = [];
  for (let cause = fields?.cause; cause; cause = cause.cause) {
    causes.push(identityOf(cause.name, cause.code));
  }
  const stack = input.stack === undefined ? (fields?.stack as ErrorStackFrames | undefined) : stackFramesOf(input.stack);
  return {
    ...(errorClass === undefined ? {} : { identity: identityOf(errorClass, fields?.code) }),
    causes,
    ...(stack ? { stack } : {}),
  };
};

const summaryOf = ({ errorClass, code }: ErrorIdentity): string => (code === undefined ? errorClass : `${errorClass} [${String(code)}]`);

/**
 * The message a report carries when its caller wrote none: the report's type, then the error's
 * class and code and each cause's, such as
 * `http.request.unhandled: AppError [service_unavailable] caused by DatabaseError [25P02]`.
 */
export const defaultReportMessage = (
  errorType: string,
  identity: ErrorIdentity | undefined,
  causes: readonly ErrorIdentity[],
): ErrorReportMessage =>
  [identity ? `${errorType}: ${summaryOf(identity)}` : errorType, ...causes.map((cause) => `caused by ${summaryOf(cause)}`)].join(
    " ",
  ) as ErrorReportMessage;

/**
 * Groups recurrences of one failure: the service, the report's type, and the error's class and
 * code. Failures of one runtime with a different class or code are different issues.
 */
export const reportFingerprint = (service: string, errorType: string, identity: ErrorIdentity | undefined): string =>
  [service, errorType, identity?.errorClass ?? "UnknownError", ...(identity?.code === undefined ? [] : [String(identity.code)])].join(":");
