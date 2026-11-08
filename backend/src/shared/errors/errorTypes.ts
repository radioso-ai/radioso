import type { CorrelationFields } from "../observability/telemetry/correlation.js";

export type ErrorSeverity = "info" | "warn" | "error";

export interface ErrorRequestContext {
  method?: string;
  route?: string;
  statusCode?: number;
}

declare const errorReportText: unique symbol;

/**
 * A report's readable message, made only by `errorReportMessage` or the reporting service's own
 * default (`errorReportShape.ts`), from source text and values whose shape rules out a person's
 * words. An error's own message is a plain `string`, so it cannot stand in for one.
 */
export type ErrorReportMessage = string & { readonly [errorReportText]: "message" };

/** A stack's frames (function, file, line and column) without the line that restates the message. */
export type ErrorStackFrames = string & { readonly [errorReportText]: "stack" };

/** An error named by its class and, when it carries one in a shape that rules out free text, its code. */
export interface ErrorIdentity {
  errorClass: string;
  code?: string | number;
}

/**
 * What every error sink receives: the audit log, metrics, the ops webhook and any exporter such as
 * PostHog. An error's message can echo a provider response, document text, SQL or a visitor's
 * words, so no field here carries it: the message and stack are the branded types above, the
 * class and code are shape-checked, and `metadata` is the caller's, key-redacted, with any `Error`
 * in it reduced to its class, code, causes and frames (`redactionPolicy.ts`).
 */
export interface ErrorEvent {
  errorType: string;
  timestamp: string;
  severity: ErrorSeverity;
  service: string;
  environment: string;
  version?: string;
  message: ErrorReportMessage;
  errorClass?: string;
  code?: string | number;
  /** What the error wraps, outermost first. */
  causes?: ErrorIdentity[];
  stack?: ErrorStackFrames;
  /** Groups recurrences of one failure: the service, the report's type, and the error's class and code. */
  fingerprint: string;
  correlation?: CorrelationFields;
  requestContext?: ErrorRequestContext;
  metadata?: Record<string, unknown>;
  tags?: Record<string, string>;
}
