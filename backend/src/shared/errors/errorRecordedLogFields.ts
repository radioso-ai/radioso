import { extractErrorLogFields } from "../observability/logger.js";
import { isStackFrame, logSafeMetadata, type LogSafeValue } from "../observability/logging/logSafeValues.js";
import type { ErrorEvent } from "./errorTypes.js";

interface ErrorRecordedLogFields {
  errorEvent?: Record<string, string>;
  metadata?: Record<string, LogSafeValue>;
  stack?: string;
}

// The error_recorded line lands in Cloud Logging, which conversation erasure cannot reach. An
// error's message, and metadata a caller attaches, can quote a visitor, so the line carries the
// error's type, class, route and stack frames, and only metadata whose shape rules out a person's
// words. The error sinks, the audit log among them, still receive the whole event.

// Metadata keys whose values the reporting code picks from a closed set: an action outbox event
// (actionDrainAfterCommit.ts), an ownership action and notification (committedOwnershipAudit.ts),
// a frontend report's source (observabilityRoutes.ts), and a background job's kind
// (backgroundJobRuntime.ts). Each value must still be a code.
const CODED_FIELDS = new Set(["event", "action", "notification", "source", "kind"]);

// A background job's error summaries, each a class and code (backgroundJobRuntime.ts).
const ERROR_SUMMARY_FIELDS = new Set(["errorClass", "lastError", "hookError"]);

const stackFrames = (stack: unknown): string | undefined => {
  const frames = (typeof stack === "string" ? stack : "").split("\n").filter(isStackFrame);
  return frames.length > 0 ? frames.join("\n") : undefined;
};

export const errorRecordedLogFields = (event: ErrorEvent): ErrorRecordedLogFields => {
  // A frontend report's React component stack keeps its frames, like the error's own stack.
  const componentStack = stackFrames(event.metadata?.componentStack);
  const metadata = {
    ...logSafeMetadata(event.metadata, { coded: CODED_FIELDS, errorSummary: ERROR_SUMMARY_FIELDS }),
    ...(componentStack ? { componentStack } : {}),
  };
  const stack = stackFrames(event.stack);

  return {
    // Not `error`: the logger serializes that key as a caught value (`logger.ts`), which would
    // reduce this already allow-listed record to its type.
    errorEvent: extractErrorLogFields(event),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    ...(stack ? { stack } : {}),
  };
};
