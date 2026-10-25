// Logs land in Cloud Logging, which conversation erasure cannot reach. A string from an event's
// own data reaches a log line only in one of these shapes, each of which rules out a person's words.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

// A lowercase code such as `chat.turn` or `safe_test`: no spaces or capitals, so never a sentence.
const CODE_PATTERN = /^[a-z][a-z0-9_.:-]{0,63}$/u;

// A JavaScript class name such as `TypeError` or `DOMException`.
const CLASS_NAME_PATTERN = /^[A-Za-z_$][\w$.]{0,127}$/u;

// A route or page path a browser's own router produced: a leading slash, then URL-path-safe
// characters only — no space, `@`, comma, or quote. A caller that only stripped a query string
// (an older convention this module replaces) can still hand this a sentence or an email address;
// this is the shape check that catches what the strip alone does not.
const PATH_SHAPE_PATTERN = /^\/[\w\-./%[\]:]*$/u;

export const isUuid = (value: string): boolean => UUID_PATTERN.test(value);

const isCode = (value: string): boolean => CODE_PATTERN.test(value);

export const isClassName = (value: string): boolean => CLASS_NAME_PATTERN.test(value);

export const isPathShape = (value: string): boolean => PATH_SHAPE_PATTERN.test(value);

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
// A path, or a `node:` core module, with no query string or fragment that could carry text.
const FRAME_FILE = String.raw`(?=[^\s()?#]*[/\\]|node:)[^\s()?#]+:\d+:\d+`;
const V8_FRAME_PATTERN = new RegExp(
  String.raw`^\s*at (?:${FRAME_NAME} \((?:${FRAME_FILE}|<anonymous>|native|index \d+)\)|(?:async )?${FRAME_FILE}|<anonymous>)$`,
  "u",
);
const BROWSER_FRAME_PATTERN = new RegExp(String.raw`^(?:async\*)?[\p{L}\p{N}_$.<>#/]*@${FRAME_FILE}$`, "u");

export const isStackFrame = (line: string): boolean =>
  line.length <= FRAME_MAX_LENGTH && (V8_FRAME_PATTERN.test(line) || BROWSER_FRAME_PATTERN.test(line));

export type LogSafeValue = string | number | boolean;

interface SafeErrorFields {
  name: string;
  code?: string;
  stack?: string;
}

// The error's own stack, minus its first line (always a restatement of the message, which is
// never safe to log) and any further line that is not a V8 or browser stack frame: a multi-line
// message indented to look like one must not survive this filter.
const safeStack = (stack: unknown): string | undefined => {
  if (typeof stack !== "string") {
    return undefined;
  }
  const frames = stack.split("\n").slice(1).filter(isStackFrame);
  return frames.length > 0 ? frames.join("\n") : undefined;
};

/**
 * What a log line may keep of a caught value: the error's class, a structural code if it set one
 * (shaped like `isCode`, so an `AppError`'s `not_found` passes while a provider's free-text code
 * does not), and its shape-checked stack frames. Never the message, the first stack line (which
 * restates it), or a `cause`'s message: this never looks past the error's own properties, so a
 * visitor's words, an email address, or a provider's response text in any of those can't reach
 * a log line through this path. The pino `err`/`error` serializer (`logger.ts`) and the
 * OpenTelemetry log bridge (`logging/index.ts`) both call this so a caught error reads the same
 * safe way everywhere it is logged.
 */
export const safeErrorFields = (error: unknown): SafeErrorFields => {
  if (!(error instanceof Error)) {
    return { name: typeof error };
  }

  const name = isClassName(error.name) ? error.name : error.constructor.name;
  const code = (error as { code?: unknown }).code;
  const stack = safeStack(error.stack);

  return {
    name,
    ...(typeof code === "string" && isCode(code) ? { code } : {}),
    ...(stack ? { stack } : {}),
  };
};

interface LogSafeMetadataKeys {
  /** Keys whose values the reporting code picks from a closed set of codes. */
  coded: ReadonlySet<string>;
  /** Keys whose values summarize an error as its class and code. */
  errorSummary?: ReadonlySet<string>;
}

// pino-http's request counter, which reaches correlation and metadata as a `requestId`.
export const isRequestCounter = (value: string): boolean => /^\d{1,20}$/u.test(value);

const isLogSafe = (key: string, value: unknown, keys: LogSafeMetadataKeys): value is LogSafeValue => {
  if (typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "string") return false;
  return (
    isUuid(value) ||
    (key === "requestId" && isRequestCounter(value)) ||
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
