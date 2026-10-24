import { extractErrorLogFields } from "../observability/logger.js";
import { isCode, isStackFrame, isUuid } from "../observability/logging/logSafeValues.js";
import type { ErrorEvent } from "./errorTypes.js";

type LoggableValue = string | number | boolean;

interface ErrorRecordedLogFields {
  error?: Record<string, string>;
  metadata?: Record<string, LoggableValue>;
  stack?: string;
}

// The error_recorded line lands in Cloud Logging, which conversation erasure cannot reach. An
// error's message, and metadata a caller attaches, can quote a visitor, so the line carries the
// error's type, class, route and stack frames, and only metadata whose shape rules out a person's
// words. The error sinks, the audit log among them, still receive the whole event.

// Metadata keys whose values the reporting code picks from a closed set: an action outbox event
// (actionDrainAfterCommit.ts), an ownership action and notification (committedOwnershipAudit.ts),
// and a frontend report's source (observabilityRoutes.ts). Each value must still be a code.
const CODED_FIELDS = new Set(["event", "action", "notification", "source"]);

const isLoggable = (key: string, value: unknown): value is LoggableValue => {
  if (typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "string") return false;
  return isUuid(value) || (CODED_FIELDS.has(key) && isCode(value));
};

const stackFrames = (stack: string | undefined): string | undefined => {
  const frames = (stack ?? "").split("\n").filter(isStackFrame);
  return frames.length > 0 ? frames.join("\n") : undefined;
};

export const errorRecordedLogFields = (event: ErrorEvent): ErrorRecordedLogFields => {
  const metadata = Object.fromEntries(
    Object.entries(event.metadata ?? {}).filter((entry): entry is [string, LoggableValue] => isLoggable(...entry)),
  );
  const stack = stackFrames(event.stack);

  return {
    error: extractErrorLogFields(event),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    ...(stack ? { stack } : {}),
  };
};
