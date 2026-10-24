// Logs land in Cloud Logging, which conversation erasure cannot reach. A string from an event's
// own data reaches a log line only in one of these shapes, each of which rules out a person's words.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

// A lowercase code such as `chat.turn` or `safe_test`: no spaces or capitals, so never a sentence.
const CODE_PATTERN = /^[a-z][a-z0-9_.:-]{0,63}$/u;

// A JavaScript class name such as `TypeError` or `DOMException`.
const CLASS_NAME_PATTERN = /^[A-Za-z_$][\w$.]{0,127}$/u;

export const isUuid = (value: string): boolean => UUID_PATTERN.test(value);

const isCode = (value: string): boolean => CODE_PATTERN.test(value);

export const isClassName = (value: string): boolean => CLASS_NAME_PATTERN.test(value);

// A class name followed by a code, such as `AppError [document_not_found]`: how a background job
// summarizes its error.
const ERROR_SUMMARY_PATTERN = /^[A-Za-z_$][\w$.]{0,127}(?: \[[a-z][a-z0-9_.:-]{0,63}\])?$/u;

const isErrorSummary = (value: string): boolean => ERROR_SUMMARY_PATTERN.test(value);

// One frame of a V8 stack, such as `    at #transformResult (file:///app/executor.js:12:5)` or
// `    at async Promise.all (index 0)`, or of a Firefox or Safari one, such as
// `async*render@/_next/static/chunks/app.js:3:4`. A frame names code and points at a file path with
// a line and column, or at a V8 placeholder, so a line of an error's message, which a person's words
// may fill, never passes. Lines past the length cap are dropped before any pattern runs.
const FRAME_MAX_LENGTH = 1024;
const FRAME_NAME = String.raw`(?:async |new )?(?:get |set )?[\p{L}\p{N}_$.<>#\[\]]+(?: \[as [\p{L}\p{N}_$.<>#]+\])?`;
const FRAME_FILE = String.raw`(?=[^\s()]*[/\\])[^\s()]+:\d+:\d+`;
const V8_FRAME_PATTERN = new RegExp(
  String.raw`^\s*at (?:${FRAME_NAME} \((?:${FRAME_FILE}|<anonymous>|native|index \d+)\)|(?:async )?${FRAME_FILE})$`,
  "u",
);
const BROWSER_FRAME_PATTERN = new RegExp(String.raw`^(?:async\*)?[\p{L}\p{N}_$.<>#/]*@${FRAME_FILE}$`, "u");

export const isStackFrame = (line: string): boolean =>
  line.length <= FRAME_MAX_LENGTH && (V8_FRAME_PATTERN.test(line) || BROWSER_FRAME_PATTERN.test(line));

export type LogSafeValue = string | number | boolean;

interface LogSafeMetadataKeys {
  /** Keys whose values the reporting code picks from a closed set of codes. */
  coded: ReadonlySet<string>;
  /** Keys whose values summarize an error as its class and code. */
  errorSummary?: ReadonlySet<string>;
}

// pino-http's request counter, which reaches metadata through the request audit context.
const isRequestCounter = (key: string, value: string): boolean => key === "requestId" && /^\d{1,20}$/u.test(value);

const isLogSafe = (key: string, value: unknown, keys: LogSafeMetadataKeys): value is LogSafeValue => {
  if (typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "string") return false;
  return (
    isUuid(value) ||
    isRequestCounter(key, value) ||
    (keys.coded.has(key) && isCode(value)) ||
    (keys.errorSummary?.has(key) === true && isErrorSummary(value))
  );
};

/**
 * The entries of an event's metadata whose shape rules out a person's words: flags, numbers, ids,
 * and codes or error summaries under the keys named for them. Nested values never pass.
 */
export const logSafeMetadata = (
  metadata: Record<string, unknown> | undefined,
  keys: LogSafeMetadataKeys,
): Record<string, LogSafeValue> | undefined => {
  const entries = Object.entries(metadata ?? {}).filter((entry): entry is [string, LogSafeValue] => isLogSafe(entry[0], entry[1], keys));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};
